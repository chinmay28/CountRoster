import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { ReminderNotFoundError } from '../src/domain/reminders.js';
import { TrackerNotFoundError } from '../src/domain/trackers.js';

describe('ReminderService', () => {
  it('create() defaults days_mask and enabled, lists for tracker', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Meds' });
    const r = await app.reminders.create({ tracker_id: t.id, time_minute: 480 });
    expect(r.time_minute).toBe(480);
    expect(r.days_mask).toBe(127);
    expect(r.enabled).toBe(1);

    const list = await app.reminders.forTracker(t.id);
    expect(list.map((x) => x.id)).toEqual([r.id]);
  });

  it('create() rejects an unknown tracker', async () => {
    const { app } = await makeTestApp();
    await expect(
      app.reminders.create({ tracker_id: 'nope', time_minute: 60 }),
    ).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it('update() and toggleEnabled() change fields', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Water' });
    const r = await app.reminders.create({ tracker_id: t.id, time_minute: 600 });

    const u = await app.reminders.update(r.id, { time_minute: 540, days_mask: 62 });
    expect(u.time_minute).toBe(540);
    expect(u.days_mask).toBe(62);

    const off = await app.reminders.toggleEnabled(r.id, false);
    expect(off.enabled).toBe(0);

    await expect(
      app.reminders.update('nope', { time_minute: 1 }),
    ).rejects.toBeInstanceOf(ReminderNotFoundError);
  });

  it('delete() removes the reminder', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Stretch' });
    const r = await app.reminders.create({ tracker_id: t.id, time_minute: 1200 });
    await app.reminders.delete(r.id);
    expect(await app.reminders.get(r.id)).toBeNull();
  });
});
