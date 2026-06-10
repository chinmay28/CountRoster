import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Tracker, TrackerLink } from '../schema/tables.js';
import {
  trackerInputSchema,
  trackerPatchSchema,
  type TrackerInput,
  type TrackerLinkInput,
  type TrackerPatch,
} from '../schema/validators.js';
import { DerivedTrackerError } from './derived.js';

export interface TrackerService {
  create(input: TrackerInput): Promise<Tracker>;
  update(id: string, patch: TrackerPatch): Promise<Tracker>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  reorder(orderedIds: readonly string[]): Promise<void>;
  get(id: string): Promise<Tracker | null>;
  list(opts?: { includeArchived?: boolean }): Promise<Tracker[]>;
  /** The source operands of a derived tracker, in order. Empty for ordinary ones. */
  links(trackerId: string): Promise<TrackerLink[]>;
  /** Replace a tracker's derivation operands (also toggles its derived flag). */
  setLinks(trackerId: string, links: readonly TrackerLinkInput[]): Promise<TrackerLink[]>;
}

export class TrackerNotFoundError extends Error {
  constructor(id: string) {
    super(`Tracker not found: ${id}`);
    this.name = 'TrackerNotFoundError';
  }
}

export function createTrackerService(
  storage: Storage,
  clock: Clock,
): TrackerService {
  return new TrackerServiceImpl(storage, clock);
}

class TrackerServiceImpl implements TrackerService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: TrackerInput): Promise<Tracker> {
    const input = trackerInputSchema.parse(rawInput);
    const id = newId();
    const now = this.clock.nowISO();
    const links = input.links ?? [];
    const isDerived = links.length > 0 ? 1 : 0;

    await this.storage.transaction(async (tx) => {
      await tx.exec(
        `INSERT INTO trackers (
          id, name, description, color, icon, kind, unit, target,
          reset_period, week_start, day_start_minute, default_value,
          archived_at, sort_order, is_derived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          id,
          input.name,
          input.description ?? null,
          input.color,
          input.icon ?? null,
          input.kind,
          input.unit ?? null,
          input.target ?? null,
          input.reset_period,
          input.week_start,
          input.day_start_minute,
          input.default_value,
          input.sort_order,
          isDerived,
          now,
          now,
        ],
      );
      if (links.length > 0) await this.replaceLinks(tx, id, links, now);
    });

    const created = await this.get(id);
    if (!created) throw new Error(`Tracker insert succeeded but row not found: ${id}`);
    return created;
  }

  async update(id: string, rawPatch: TrackerPatch): Promise<Tracker> {
    const patch = trackerPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new TrackerNotFoundError(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    const assign = <K extends keyof TrackerPatch>(key: K, column: string): void => {
      if (key in patch && patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        const v = patch[key];
        params.push(v === null ? null : (v as string | number));
      }
    };

    assign('name', 'name');
    assign('description', 'description');
    assign('color', 'color');
    assign('icon', 'icon');
    assign('kind', 'kind');
    assign('unit', 'unit');
    assign('target', 'target');
    assign('reset_period', 'reset_period');
    assign('week_start', 'week_start');
    assign('day_start_minute', 'day_start_minute');
    assign('default_value', 'default_value');
    assign('sort_order', 'sort_order');

    // A supplied `links` list replaces the derivation wholesale and re-derives
    // the `is_derived` flag from whether any operands remain.
    const replacingLinks = 'links' in patch && patch.links !== undefined;
    if (replacingLinks) {
      sets.push('is_derived = ?');
      params.push(patch.links!.length > 0 ? 1 : 0);
    }

    if (sets.length === 0) return existing;

    const now = this.clock.nowISO();
    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    await this.storage.transaction(async (tx) => {
      await tx.exec(`UPDATE trackers SET ${sets.join(', ')} WHERE id = ?`, params);
      if (replacingLinks) await this.replaceLinks(tx, id, patch.links!, now);
    });

    const updated = await this.get(id);
    if (!updated) throw new TrackerNotFoundError(id);
    return updated;
  }

  async archive(id: string): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.exec(
      `UPDATE trackers SET archived_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  async unarchive(id: string): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.exec(
      `UPDATE trackers SET archived_at = NULL, updated_at = ? WHERE id = ?`,
      [now, id],
    );
  }

  async delete(id: string): Promise<void> {
    // Permanent, unlike archive(). Entries, notes (and their edit log),
    // options, reminders, and group memberships cascade via ON DELETE CASCADE.
    await this.storage.exec(`DELETE FROM trackers WHERE id = ?`, [id]);
  }

  async reorder(orderedIds: readonly string[]): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.exec(
          `UPDATE trackers SET sort_order = ?, updated_at = ? WHERE id = ?`,
          [i, now, orderedIds[i]!],
        );
      }
    });
  }

  async get(id: string): Promise<Tracker | null> {
    const rows = await this.storage.query<Tracker>(
      `SELECT * FROM trackers WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(opts: { includeArchived?: boolean } = {}): Promise<Tracker[]> {
    const includeArchived = opts.includeArchived ?? false;
    const sql = includeArchived
      ? `SELECT * FROM trackers ORDER BY sort_order ASC, created_at ASC`
      : `SELECT * FROM trackers WHERE archived_at IS NULL
         ORDER BY sort_order ASC, created_at ASC`;
    return this.storage.query<Tracker>(sql);
  }

  async links(trackerId: string): Promise<TrackerLink[]> {
    return this.storage.query<TrackerLink>(
      `SELECT * FROM tracker_links WHERE tracker_id = ?
        ORDER BY sort_order ASC, created_at ASC`,
      [trackerId],
    );
  }

  async setLinks(
    trackerId: string,
    links: readonly TrackerLinkInput[],
  ): Promise<TrackerLink[]> {
    const existing = await this.get(trackerId);
    if (!existing) throw new TrackerNotFoundError(trackerId);

    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      await tx.exec(
        `UPDATE trackers SET is_derived = ?, updated_at = ? WHERE id = ?`,
        [links.length > 0 ? 1 : 0, now, trackerId],
      );
      await this.replaceLinks(tx, trackerId, links, now);
    });
    return this.links(trackerId);
  }

  /**
   * Validate and (re)write a derived tracker's operands inside a transaction.
   * Each source must exist, be ordinary (no derived-of-derived nesting), and
   * not be the tracker itself. Replaces any prior links.
   */
  private async replaceLinks(
    tx: Storage,
    trackerId: string,
    links: readonly TrackerLinkInput[],
    now: string,
  ): Promise<void> {
    await tx.exec(`DELETE FROM tracker_links WHERE tracker_id = ?`, [trackerId]);
    if (links.length === 0) return;

    // Reject duplicate sources up front — the table's UNIQUE constraint would
    // otherwise fail mid-insert with an opaque error.
    const seen = new Set<string>();
    for (const link of links) {
      if (link.source_id === trackerId) {
        throw new DerivedTrackerError('A derived tracker cannot reference itself.');
      }
      if (seen.has(link.source_id)) {
        throw new DerivedTrackerError(
          `Duplicate source tracker in derivation: ${link.source_id}`,
        );
      }
      seen.add(link.source_id);
    }

    const sources = await tx.query<{ id: string; is_derived: number }>(
      `SELECT id, is_derived FROM trackers
        WHERE id IN (${links.map(() => '?').join(', ')})`,
      links.map((l) => l.source_id),
    );
    const byId = new Map(sources.map((s) => [s.id, s]));
    for (const link of links) {
      const source = byId.get(link.source_id);
      if (!source) {
        throw new DerivedTrackerError(`Source tracker not found: ${link.source_id}`);
      }
      if (source.is_derived === 1) {
        throw new DerivedTrackerError(
          `A derived tracker cannot be a source of another derived tracker: ${link.source_id}`,
        );
      }
    }

    for (let i = 0; i < links.length; i++) {
      const link = links[i]!;
      await tx.exec(
        `INSERT INTO tracker_links
           (id, tracker_id, source_id, coefficient, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), trackerId, link.source_id, link.coefficient, i, now],
      );
    }
  }
}
