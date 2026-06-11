import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type { TrackerGroup, Tracker } from '../schema/tables.js';
import {
  groupInputSchema,
  groupPatchSchema,
  type GroupInput,
  type GroupPatch,
} from '../schema/validators.js';

export interface GroupService {
  create(input: GroupInput): Promise<TrackerGroup>;
  update(id: string, patch: GroupPatch): Promise<TrackerGroup>;
  delete(id: string): Promise<void>;
  get(id: string): Promise<TrackerGroup | null>;
  list(): Promise<TrackerGroup[]>;
  /** Reorder all groups to match the given group-id order. */
  reorder(orderedGroupIds: readonly string[]): Promise<void>;
  /** Trackers that belong to a group, in membership sort order. */
  trackersIn(groupId: string): Promise<Tracker[]>;
  /** Add a tracker to a group (idempotent). */
  addTracker(groupId: string, trackerId: string): Promise<void>;
  /** Remove a tracker from a group (no-op if absent). */
  removeTracker(groupId: string, trackerId: string): Promise<void>;
  /** Reorder a group's members to match the given tracker-id order. */
  reorderMembers(groupId: string, orderedTrackerIds: readonly string[]): Promise<void>;
}

export class GroupNotFoundError extends Error {
  constructor(id: string) {
    super(`Group not found: ${id}`);
    this.name = 'GroupNotFoundError';
  }
}

export function createGroupService(
  storage: Storage,
  clock: Clock,
): GroupService {
  return new GroupServiceImpl(storage, clock);
}

class GroupServiceImpl implements GroupService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: GroupInput): Promise<TrackerGroup> {
    const input = groupInputSchema.parse(rawInput);
    const id = newId();
    const now = this.clock.nowISO();

    await this.storage.exec(
      `INSERT INTO tracker_groups (id, name, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.color ?? null, input.sort_order, now, now],
    );

    const created = await this.get(id);
    if (!created) throw new Error(`Group insert succeeded but row not found: ${id}`);
    return created;
  }

  async update(id: string, rawPatch: GroupPatch): Promise<TrackerGroup> {
    const patch = groupPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new GroupNotFoundError(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if ('name' in patch && patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if ('color' in patch && patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if ('sort_order' in patch && patch.sort_order !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sort_order);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(this.clock.nowISO());
    params.push(id);

    await this.storage.exec(
      `UPDATE tracker_groups SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) throw new GroupNotFoundError(id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    // Memberships cascade via the FK ON DELETE CASCADE.
    await this.storage.exec(`DELETE FROM tracker_groups WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<TrackerGroup | null> {
    const rows = await this.storage.query<TrackerGroup>(
      `SELECT * FROM tracker_groups WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(): Promise<TrackerGroup[]> {
    return this.storage.query<TrackerGroup>(
      `SELECT * FROM tracker_groups ORDER BY sort_order ASC, created_at ASC`,
    );
  }

  async reorder(orderedGroupIds: readonly string[]): Promise<void> {
    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      for (let i = 0; i < orderedGroupIds.length; i++) {
        await tx.exec(
          `UPDATE tracker_groups SET sort_order = ?, updated_at = ? WHERE id = ?`,
          [i, now, orderedGroupIds[i]!],
        );
      }
    });
  }

  async trackersIn(groupId: string): Promise<Tracker[]> {
    return this.storage.query<Tracker>(
      `SELECT t.* FROM trackers t
         JOIN tracker_group_memberships m ON m.tracker_id = t.id
        WHERE m.group_id = ?
        ORDER BY m.sort_order ASC, t.created_at ASC`,
      [groupId],
    );
  }

  async addTracker(groupId: string, trackerId: string): Promise<void> {
    // Append to the end of the group's current order.
    const rows = await this.storage.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
         FROM tracker_group_memberships WHERE group_id = ?`,
      [groupId],
    );
    const next = rows[0]?.next ?? 0;
    await this.storage.exec(
      `INSERT INTO tracker_group_memberships (tracker_id, group_id, sort_order)
       VALUES (?, ?, ?)
       ON CONFLICT(tracker_id, group_id) DO NOTHING`,
      [trackerId, groupId, next],
    );
  }

  async removeTracker(groupId: string, trackerId: string): Promise<void> {
    await this.storage.exec(
      `DELETE FROM tracker_group_memberships WHERE group_id = ? AND tracker_id = ?`,
      [groupId, trackerId],
    );
  }

  async reorderMembers(
    groupId: string,
    orderedTrackerIds: readonly string[],
  ): Promise<void> {
    await this.storage.transaction(async (tx) => {
      for (let i = 0; i < orderedTrackerIds.length; i++) {
        await tx.exec(
          `UPDATE tracker_group_memberships SET sort_order = ?
            WHERE group_id = ? AND tracker_id = ?`,
          [i, groupId, orderedTrackerIds[i]!],
        );
      }
    });
  }
}
