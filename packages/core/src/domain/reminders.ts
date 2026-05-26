import type { Storage } from '../storage/adapter.js';
import type { Clock } from '../time.js';
import type { Reminder } from '../schema/tables.js';

export interface ReminderService {
  forTracker(trackerId: string): Promise<Reminder[]>;
  // TODO: create / update / toggleEnabled / delete
}

export function createReminderService(
  storage: Storage,
  _clock: Clock,
): ReminderService {
  return {
    async forTracker(trackerId: string): Promise<Reminder[]> {
      return storage.query<Reminder>(
        `SELECT * FROM reminders WHERE tracker_id = ? ORDER BY time_minute ASC`,
        [trackerId],
      );
    },
  };
}
