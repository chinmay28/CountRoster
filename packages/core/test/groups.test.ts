import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { GroupNotFoundError } from '../src/domain/groups.js';

describe('GroupService', () => {
  it('create() / get() / list() round-trips', async () => {
    const { app } = await makeTestApp();
    const g = await app.groups.create({ name: 'Health', color: '#4ECDC4' });
    expect(g.name).toBe('Health');
    expect(g.color).toBe('#4ECDC4');

    expect(await app.groups.get(g.id)).toEqual(g);
    const all = await app.groups.list();
    expect(all.map((x) => x.id)).toEqual([g.id]);
  });

  it('update() patches fields and throws for unknown id', async () => {
    const { app } = await makeTestApp();
    const g = await app.groups.create({ name: 'Old' });
    const updated = await app.groups.update(g.id, { name: 'New' });
    expect(updated.name).toBe('New');

    await expect(app.groups.update('nope', { name: 'x' })).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
  });

  it('adds, lists, reorders, and removes member trackers', async () => {
    const { app } = await makeTestApp();
    const g = await app.groups.create({ name: 'Morning' });
    const a = await app.trackers.create({ name: 'A' });
    const b = await app.trackers.create({ name: 'B' });

    await app.groups.addTracker(g.id, a.id);
    await app.groups.addTracker(g.id, b.id);
    await app.groups.addTracker(g.id, a.id); // idempotent

    let members = await app.groups.trackersIn(g.id);
    expect(members.map((t) => t.id)).toEqual([a.id, b.id]);

    await app.groups.reorderMembers(g.id, [b.id, a.id]);
    members = await app.groups.trackersIn(g.id);
    expect(members.map((t) => t.id)).toEqual([b.id, a.id]);

    await app.groups.removeTracker(g.id, b.id);
    members = await app.groups.trackersIn(g.id);
    expect(members.map((t) => t.id)).toEqual([a.id]);
  });

  it('reorder() sets sort_order to match the given group order', async () => {
    const { app } = await makeTestApp();
    const a = await app.groups.create({ name: 'A' });
    const b = await app.groups.create({ name: 'B' });
    const c = await app.groups.create({ name: 'C' });

    // Default order is creation order (all sort_order 0, tie-broken by created_at).
    expect((await app.groups.list()).map((g) => g.id)).toEqual([a.id, b.id, c.id]);

    await app.groups.reorder([c.id, a.id, b.id]);
    expect((await app.groups.list()).map((g) => g.id)).toEqual([c.id, a.id, b.id]);
  });

  it('delete() cascades memberships', async () => {
    const { app, storage } = await makeTestApp();
    const g = await app.groups.create({ name: 'Temp' });
    const t = await app.trackers.create({ name: 'T' });
    await app.groups.addTracker(g.id, t.id);

    await app.groups.delete(g.id);
    expect(await app.groups.get(g.id)).toBeNull();
    const rows = await storage.query(
      `SELECT * FROM tracker_group_memberships WHERE group_id = ?`,
      [g.id],
    );
    expect(rows).toHaveLength(0);
  });
});
