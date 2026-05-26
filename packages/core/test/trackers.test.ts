import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { TrackerNotFoundError } from '../src/domain/trackers.js';

describe('TrackerService', () => {
  it('creates a tracker with sensible defaults', async () => {
    const { app } = await makeTestApp();
    const tracker = await app.trackers.create({ name: 'Water' });

    expect(tracker.name).toBe('Water');
    expect(tracker.kind).toBe('count');
    expect(tracker.reset_period).toBe('never');
    expect(tracker.default_value).toBe(1);
    expect(tracker.color).toBe('#888888');
    expect(tracker.archived_at).toBeNull();
    expect(tracker.id).toBeTruthy();
    expect(tracker.created_at).toBe(tracker.updated_at);
  });

  it('rejects an empty name', async () => {
    const { app } = await makeTestApp();
    await expect(app.trackers.create({ name: '   ' })).rejects.toThrow();
  });

  it('rejects an invalid color', async () => {
    const { app } = await makeTestApp();
    await expect(
      app.trackers.create({ name: 'X', color: 'red' }),
    ).rejects.toThrow();
  });

  it('updates fields via update()', async () => {
    const { app, setTime } = await makeTestApp('2026-05-25T12:00:00.000-07:00');
    const created = await app.trackers.create({ name: 'Coffee' });

    setTime('2026-05-25T15:00:00.000-07:00');
    const updated = await app.trackers.update(created.id, {
      name: 'Espresso',
      target: 3,
    });

    expect(updated.name).toBe('Espresso');
    expect(updated.target).toBe(3);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated.created_at).toBe(created.created_at);
  });

  it('archive sets archived_at, unarchive clears it', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Pushups' });

    await app.trackers.archive(t.id);
    const archived = await app.trackers.get(t.id);
    expect(archived?.archived_at).toBeTruthy();

    await app.trackers.unarchive(t.id);
    const unarchived = await app.trackers.get(t.id);
    expect(unarchived?.archived_at).toBeNull();
  });

  it('list excludes archived by default, includes them when asked', async () => {
    const { app } = await makeTestApp();
    const a = await app.trackers.create({ name: 'A' });
    const b = await app.trackers.create({ name: 'B' });
    await app.trackers.archive(b.id);

    const active = await app.trackers.list();
    expect(active.map((t) => t.id)).toEqual([a.id]);

    const all = await app.trackers.list({ includeArchived: true });
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('reorder rewrites sort_order in the given sequence', async () => {
    const { app } = await makeTestApp();
    const a = await app.trackers.create({ name: 'A', sort_order: 0 });
    const b = await app.trackers.create({ name: 'B', sort_order: 1 });
    const c = await app.trackers.create({ name: 'C', sort_order: 2 });

    await app.trackers.reorder([c.id, a.id, b.id]);

    const list = await app.trackers.list();
    expect(list.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
  });

  it('update throws TrackerNotFoundError for unknown id', async () => {
    const { app } = await makeTestApp();
    await expect(
      app.trackers.update('00000000-0000-0000-0000-000000000000', { name: 'X' }),
    ).rejects.toBeInstanceOf(TrackerNotFoundError);
  });
});
