import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';

/**
 * Snapshot trackers record the *level* of a statistic (net worth, weight) at
 * a point in time. Their entries never add up: the current value is the most
 * recent entry, and buckets take the last snapshot in the period.
 */
describe('snapshot trackers', () => {
  it('defaults to an ordinary (non-snapshot) tracker', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Coffee' });
    expect(t.is_snapshot).toBe(0);
  });

  it('normalizes reset_period to never on create', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Net worth',
      kind: 'number',
      is_snapshot: 1,
      reset_period: 'monthly',
    });
    expect(t.is_snapshot).toBe(1);
    expect(t.reset_period).toBe('never');
  });

  it('normalizes reset_period to never when a tracker becomes a snapshot', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Weight', reset_period: 'weekly' });
    const updated = await app.trackers.update(t.id, { is_snapshot: 1 });
    expect(updated.is_snapshot).toBe(1);
    expect(updated.reset_period).toBe('never');

    // And it stays 'never' even if a later patch tries to set one.
    const patched = await app.trackers.update(t.id, { reset_period: 'daily' });
    expect(patched.reset_period).toBe('never');
  });

  it('buckets take the last snapshot in each period instead of summing', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Net worth',
      kind: 'number',
      is_snapshot: 1,
    });

    // Two readings in April (the later one wins), one in May, none in March.
    await app.entries.log(t.id, { value: 1000, occurred_at: '2026-04-05T10:00:00.000-07:00' });
    await app.entries.log(t.id, { value: 1200, occurred_at: '2026-04-20T10:00:00.000-07:00' });
    await app.entries.log(t.id, { value: 1100, occurred_at: '2026-05-10T10:00:00.000-07:00' });

    const buckets = await app.stats.bucket(
      t.id,
      { start: '2026-03-01T00:00:00.000-07:00', end: '2026-06-01T00:00:00.000-07:00' },
      'month',
    );
    // Depending on the host timezone the range may spill into one extra
    // empty bucket at either edge; compare only the buckets that hold data
    // plus the empty March one.
    const populated = buckets.filter((b) => b.count > 0);
    expect(populated.map((b) => ({ value: b.value, count: b.count }))).toEqual([
      { value: 1200, count: 2 }, // April: last of the two readings, not 2200
      { value: 1100, count: 1 }, // May
    ]);
    expect(buckets.some((b) => b.count === 0)).toBe(true); // March stays empty
  });

  it('an ordinary tracker still sums its buckets', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Sales', kind: 'number' });
    await app.entries.log(t.id, { value: 10, occurred_at: '2026-04-05T10:00:00.000-07:00' });
    await app.entries.log(t.id, { value: 15, occurred_at: '2026-04-20T10:00:00.000-07:00' });

    const buckets = await app.stats.bucket(
      t.id,
      { start: '2026-04-01T00:00:00.000-07:00', end: '2026-05-01T00:00:00.000-07:00' },
      'month',
    );
    expect(buckets[0]!.value).toBe(25);
  });

  it('targetProgress uses the latest snapshot, not a sum', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Net worth',
      kind: 'number',
      is_snapshot: 1,
      target: 2000,
    });
    await app.entries.log(t.id, { value: 800, occurred_at: '2026-05-01T10:00:00.000-07:00' });
    await app.entries.log(t.id, { value: 1000, occurred_at: '2026-05-20T10:00:00.000-07:00' });

    const progress = await app.stats.targetProgress(t.id);
    expect(progress.current).toBe(1000); // latest reading — not 1800
    expect(progress.ratio).toBe(0.5);
  });

  it('round-trips is_snapshot through a backup', async () => {
    const { app } = await makeTestApp();
    await app.trackers.create({ name: 'Net worth', kind: 'number', is_snapshot: 1 });
    const bytes = await app.backup.exportBundle({ app_version: '1.0.0' });

    const dest = await makeTestApp();
    await dest.app.backup.importBundle(bytes);
    const restored = await dest.app.trackers.list();
    expect(restored[0]!.is_snapshot).toBe(1);
  });
});
