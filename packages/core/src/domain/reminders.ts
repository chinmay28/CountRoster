import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { Reminder } from '../schema/tables.js';
import {
  reminderInputSchema,
  reminderPatchSchema,
  type ReminderInput,
  type ReminderPatch,
} from '../schema/validators.js';
import { TrackerNotFoundError } from './trackers.js';

export interface ReminderService {
  create(input: ReminderInput): Promise<Reminder>;
  update(id: string, patch: ReminderPatch): Promise<Reminder>;
  toggleEnabled(id: string, enabled: boolean): Promise<Reminder>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<Reminder | null>;
  forTracker(trackerId: string): Promise<Reminder[]>;
}

export class ReminderNotFoundError extends Error {
  constructor(id: string) {
    super(`Reminder not found: ${id}`);
    this.name = 'ReminderNotFoundError';
  }
}

export function createReminderService(
  storage: Storage,
  clock: Clock,
): ReminderService {
  return new ReminderServiceImpl(storage, clock);
}

class ReminderServiceImpl implements ReminderService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: ReminderInput): Promise<Reminder> {
    const input = reminderInputSchema.parse(rawInput);

    const trackerRows = await this.storage.query<{ id: string }>(
      `SELECT id FROM trackers WHERE id = ?`,
      [input.tracker_id],
    );
    if (trackerRows.length === 0) throw new TrackerNotFoundError(input.tracker_id);

    const id = newId();
    const now = this.clock.nowISO();
    await this.storage.exec(
      `INSERT INTO reminders
         (id, tracker_id, time_minute, days_mask, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tracker_id, input.time_minute, input.days_mask, input.enabled, now, now],
    );

    const created = await this.get(id);
    if (!created) throw new Error(`Reminder insert succeeded but row not found: ${id}`);
    return created;
  }

  async update(id: string, rawPatch: ReminderPatch): Promise<Reminder> {
    const patch = reminderPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new ReminderNotFoundError(id);

    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.time_minute !== undefined) {
      sets.push('time_minute = ?');
      params.push(patch.time_minute);
    }
    if (patch.days_mask !== undefined) {
      sets.push('days_mask = ?');
      params.push(patch.days_mask);
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(this.clock.nowISO());
    params.push(id);

    await this.storage.exec(
      `UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) throw new ReminderNotFoundError(id);
    return updated;
  }

  async toggleEnabled(id: string, enabled: boolean): Promise<Reminder> {
    return this.update(id, { enabled: enabled ? 1 : 0 });
  }

  async delete(id: string): Promise<void> {
    await this.storage.exec(`DELETE FROM reminders WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<Reminder | null> {
    const rows = await this.storage.query<Reminder>(
      `SELECT * FROM reminders WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async forTracker(trackerId: string): Promise<Reminder[]> {
    return this.storage.query<Reminder>(
      `SELECT * FROM reminders WHERE tracker_id = ? ORDER BY time_minute ASC`,
      [trackerId],
    );
  }
}
