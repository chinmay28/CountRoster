import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { TrackerNotFoundError } from '../src/domain/trackers.js';
import { EntryNotFoundError } from '../src/domain/entries.js';

describe('EntryService', () => {
  it('log() uses tracker.default_value when no value is provided', async () => {
    const { app } = await makeTestApp();
    const tracker = await app.trackers.create({ name: 'Reps', default_value: 10 });

    const entry = await app.entries.log(tracker.id);
    expect(entry.value).toBe(10);
    expect(entry.tracker_id).toBe(tracker.id);
  });

  it('log() accepts a custom value and occurred_at', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Weight', kind: 'number' });

    const e = await app.entries.log(t.id, {
      value: 175.4,
      occurred_at: '2026-04-01T08:00:00.000-07:00',
    });
    expect(e.value).toBe(175.4);
    expect(e.occurred_at).toBe('2026-04-01T08:00:00.000-07:00');
  });

  it('log() throws TrackerNotFoundError for an unknown tracker', async () => {
    const { app } = await makeTestApp();
    await expect(app.entries.log('does-not-exist')).rejects.toBeInstanceOf(
      TrackerNotFoundError,
    );
  });

  it('update() patches value and occurred_at', async () => {
    const { app, setTime } = await makeTestApp('2026-05-25T12:00:00.000-07:00');
    const t = await app.trackers.create({ name: 'Coffee' });
    const e = await app.entries.log(t.id);

    setTime('2026-05-25T13:00:00.000-07:00');
    const patched = await app.entries.update(e.id, { value: 2 });
    expect(patched.value).toBe(2);
    expect(patched.updated_at).not.toBe(e.updated_at);
  });

  it('update() throws EntryNotFoundError for an unknown entry', async () => {
    const { app } = await makeTestApp();
    await expect(
      app.entries.update('nope', { value: 1 }),
    ).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  it('delete() removes the entry', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    const e = await app.entries.log(t.id);

    await app.entries.delete(e.id);
    expect(await app.entries.get(e.id)).toBeNull();
  });

  it('forTracker() returns entries in occurred_at order', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });

    const e1 = await app.entries.log(t.id, { occurred_at: '2026-05-20T10:00:00.000-07:00' });
    const e2 = await app.entries.log(t.id, { occurred_at: '2026-05-22T10:00:00.000-07:00' });
    const e3 = await app.entries.log(t.id, { occurred_at: '2026-05-21T10:00:00.000-07:00' });

    const all = await app.entries.forTracker(t.id);
    expect(all.map((e) => e.id)).toEqual([e1.id, e3.id, e2.id]);
  });

  it('forTracker() filters by range', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });

    await app.entries.log(t.id, { occurred_at: '2026-05-20T10:00:00.000-07:00' });
    const inside = await app.entries.log(t.id, {
      occurred_at: '2026-05-22T10:00:00.000-07:00',
    });
    await app.entries.log(t.id, { occurred_at: '2026-05-24T10:00:00.000-07:00' });

    const filtered = await app.entries.forTracker(t.id, {
      start: '2026-05-21T00:00:00.000-07:00',
      end: '2026-05-23T00:00:00.000-07:00',
    });
    expect(filtered.map((e) => e.id)).toEqual([inside.id]);
  });

  it('forTracker() compares by instant across mismatched offsets', async () => {
    // An entry stored in the server's offset (+00:00) at 03:00 UTC is, in a
    // client's -08:00 timezone, still the *previous* calendar day — so a
    // "today" range expressed in -08:00 must exclude it. A naive lexical
    // string comparison would wrongly include it (this was the bug behind a
    // tracker reading 0 on one device but correct on another).
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });

    // 2026-05-22T03:00Z === 2026-05-21T19:00 in -08:00 (the day before).
    const prevDay = await app.entries.log(t.id, {
      occurred_at: '2026-05-22T03:00:00.000+00:00',
    });
    // 2026-05-22T20:00Z === 2026-05-22T12:00 in -08:00 (the requested day).
    const sameDay = await app.entries.log(t.id, {
      occurred_at: '2026-05-22T20:00:00.000+00:00',
    });

    const today = await app.entries.forTracker(t.id, {
      start: '2026-05-22T00:00:00.000-08:00',
      end: '2026-05-23T00:00:00.000-08:00',
    });
    expect(today.map((e) => e.id)).toEqual([sameDay.id]);
    expect(today.map((e) => e.id)).not.toContain(prevDay.id);
  });

  it('deleting a tracker cascades to its entries', async () => {
    const { app, storage } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    await app.entries.log(t.id);
    await app.entries.log(t.id);

    await storage.exec(`DELETE FROM trackers WHERE id = ?`, [t.id]);
    const rows = await storage.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM entries WHERE tracker_id = ?`,
      [t.id],
    );
    expect(rows[0]!.c).toBe(0);
  });
});
