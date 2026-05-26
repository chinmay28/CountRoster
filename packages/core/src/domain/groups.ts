import type { Storage } from '../storage/adapter.js';
import type { Clock } from '../time.js';
import type { TrackerGroup } from '../schema/tables.js';

export interface GroupService {
  list(): Promise<TrackerGroup[]>;
  // TODO: create / update / delete / addTracker / removeTracker / reorder
}

export function createGroupService(
  storage: Storage,
  _clock: Clock,
): GroupService {
  return {
    async list(): Promise<TrackerGroup[]> {
      return storage.query<TrackerGroup>(
        `SELECT * FROM tracker_groups ORDER BY sort_order ASC, created_at ASC`,
      );
    },
  };
}
