import type { SqlParam, Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Entry } from '../schema/tables.js';
import {
  entryLogInputSchema,
  entryLogManyInputSchema,
  entryPatchSchema,
  type EntryLogInput,
  type EntryLogManyInput,
  type EntryPatch,
} from '../schema/validators.js';
import { TrackerNotFoundError } from './trackers.js';
import { DerivedTrackerError, effectiveEntrySource } from './derived.js';

export interface TimeRange {
  /** Inclusive ISO 8601 lower bound. */
  start?: string;
  /** Exclusive ISO 8601 upper bound. */
  end?: string;
}

export interface EntryService {
  /**
   * Log a new entry. Defaults: value = tracker.default_value, occurred_at = now.
   * Throws TrackerNotFoundError if the tracker doesn't exist.
   */
  log(trackerId: string, input?: EntryLogInput): Promise<Entry>;
  /**
   * Log a batch of entries — possibly across different trackers — atomically:
   * either every item is inserted or none are. Per-item defaults match log()
   * (value = tracker.default_value, occurred_at = now). Returns the persisted
   * entries in input order.
   */
  logMany(inputs: EntryLogManyInput): Promise<Entry[]>;
  update(id: string, patch: EntryPatch): Promise<Entry>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<Entry | null>;
  forTracker(trackerId: string, range?: TimeRange): Promise<Entry[]>;
}

export class EntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Entry not found: ${id}`);
    this.name = 'EntryNotFoundError';
  }
}

export function createEntryService(
  storage: Storage,
  clock: Clock,
): EntryService {
  return new EntryServiceImpl(storage, clock);
}

class EntryServiceImpl implements EntryService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async log(trackerId: string, rawInput: EntryLogInput = {}): Promise<Entry> {
    const input = entryLogInputSchema.parse(rawInput);

    // Look up the tracker's default_value so a bare .log() does the right thing.
    const trackerRows = await this.storage.query<{
      default_value: number;
      is_derived: number;
    }>(
      `SELECT default_value, is_derived FROM trackers WHERE id = ?`,
      [trackerId],
    );
    if (trackerRows.length === 0) throw new TrackerNotFoundError(trackerId);
    if (trackerRows[0]!.is_derived === 1) {
      throw new DerivedTrackerError(
        'Cannot log entries on a derived tracker; its value is computed from its sources.',
      );
    }

    const now = this.clock.nowISO();
    const id = newId();
    const value = input.value ?? trackerRows[0]!.default_value;
    const occurredAt = input.occurred_at ?? now;

    await this.storage.exec(
      `INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, trackerId, value, occurredAt, now, now],
    );

    const created = await this.get(id);
    if (!created) throw new Error(`Entry insert succeeded but row not found: ${id}`);
    return created;
  }

  async logMany(rawInputs: EntryLogManyInput): Promise<Entry[]> {
    const inputs = entryLogManyInputSchema.parse(rawInputs);

    const ids = await this.storage.transaction(async (tx) => {
      // Validate every distinct tracker up front so a bad item rolls back the
      // whole batch before any row lands.
      const defaults = new Map<string, number>();
      for (const trackerId of new Set(inputs.map((i) => i.tracker_id))) {
        const rows = await tx.query<{
          default_value: number;
          is_derived: number;
        }>(
          `SELECT default_value, is_derived FROM trackers WHERE id = ?`,
          [trackerId],
        );
        if (rows.length === 0) throw new TrackerNotFoundError(trackerId);
        if (rows[0]!.is_derived === 1) {
          throw new DerivedTrackerError(
            'Cannot log entries on a derived tracker; its value is computed from its sources.',
          );
        }
        defaults.set(trackerId, rows[0]!.default_value);
      }

      const now = this.clock.nowISO();
      const inserted: string[] = [];
      for (const input of inputs) {
        const id = newId();
        await tx.exec(
          `INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.tracker_id,
            input.value ?? defaults.get(input.tracker_id)!,
            input.occurred_at ?? now,
            now,
            now,
          ],
        );
        inserted.push(id);
      }
      return inserted;
    });

    const rows = await this.storage.query<Entry>(
      `SELECT * FROM entries WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Entry insert succeeded but row not found: ${id}`);
      return entry;
    });
  }

  async update(id: string, rawPatch: EntryPatch): Promise<Entry> {
    const patch = entryPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new EntryNotFoundError(id);

    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.value !== undefined) {
      sets.push('value = ?');
      params.push(patch.value);
    }
    if (patch.occurred_at !== undefined) {
      sets.push('occurred_at = ?');
      params.push(patch.occurred_at);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(this.clock.nowISO());
    params.push(id);

    await this.storage.exec(
      `UPDATE entries SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) throw new EntryNotFoundError(id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.storage.exec(`DELETE FROM entries WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<Entry | null> {
    const rows = await this.storage.query<Entry>(
      `SELECT * FROM entries WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async forTracker(trackerId: string, range: TimeRange = {}): Promise<Entry[]> {
    // For a derived tracker this resolves to a virtual stream of its sources'
    // entries (each scaled by its coefficient); for an ordinary tracker it's
    // just its own `entries`. Either way the range filter and ordering below
    // are identical.
    const source = await effectiveEntrySource(this.storage, trackerId);
    const where: string[] = [];
    const params: SqlParam[] = [...source.params];
    // Compare by absolute instant, not lexically: occurred_at is stored with
    // the *server's* local offset, but a client may request a range in a
    // *different* offset (e.g. a desktop in another timezone than the box that
    // logged the entry). A plain string `>=` is wrong across mismatched
    // offsets — `julianday()` parses the offset so both sides are compared as
    // the same moment in time. (This is why a tracker could read 0 on one
    // device and correctly on another.)
    if (range.start !== undefined) {
      where.push('julianday(occurred_at) >= julianday(?)');
      params.push(range.start);
    }
    if (range.end !== undefined) {
      where.push('julianday(occurred_at) < julianday(?)');
      params.push(range.end);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    return this.storage.query<Entry>(
      `SELECT * FROM ${source.sql}${whereSql}
       ORDER BY occurred_at ASC, id ASC`,
      params,
    );
  }
}
