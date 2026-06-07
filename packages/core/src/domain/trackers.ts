import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Tracker } from '../schema/tables.js';
import {
  trackerInputSchema,
  trackerPatchSchema,
  type TrackerInput,
  type TrackerPatch,
} from '../schema/validators.js';

export interface TrackerService {
  create(input: TrackerInput): Promise<Tracker>;
  update(id: string, patch: TrackerPatch): Promise<Tracker>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  reorder(orderedIds: readonly string[]): Promise<void>;
  get(id: string): Promise<Tracker | null>;
  list(opts?: { includeArchived?: boolean }): Promise<Tracker[]>;
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

    await this.storage.exec(
      `INSERT INTO trackers (
        id, name, description, color, icon, kind, unit, target,
        reset_period, week_start, day_start_minute, default_value,
        archived_at, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
        now,
        now,
      ],
    );

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

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(this.clock.nowISO());
    params.push(id);

    await this.storage.exec(
      `UPDATE trackers SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

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
}
