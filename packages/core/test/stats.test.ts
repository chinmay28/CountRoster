import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { toLocalISO } from '../src/time.js';

const OFF = '-07:00';
const day = (d: string, h = 12) =>
  `2026-05-${d}T${String(h).padStart(2, '0')}:00:00.000${OFF}`;

describe('StatsService.bucket', () => {
  it('sums entries into one bucket per day, zero-filling gaps', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Steps', kind: 'number' });
    await app.entries.log(t.id, { value: 3, occurred_at: day('20') });
    await app.entries.log(t.id, { value: 4, occurred_at: day('20', 18) });
    await app.entries.log(t.id, { value: 5, occurred_at: day('22') });

    const buckets = await app.stats.bucket(
      t.id,
      { start: day('20', 0), end: day('23', 0) },
      'day',
    );

    // Buckets tile the range contiguously (each end is the next start).
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.start).toBe(buckets[i - 1]!.end);
    }
    const totalValue = buckets.reduce((s, b) => s + b.value, 0);
    const totalCount = buckets.reduce((s, b) => s + b.count, 0);
    expect(totalValue).toBe(12);
    expect(totalCount).toBe(3);
    // At least one day in the span has no entries (zero-filled).
    expect(buckets.some((b) => b.value === 0 && b.count === 0)).toBe(true);
  });

  it('filters by absolute instant when the range uses a different offset', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Steps', kind: 'number' });
    // 2026-05-20T12:00-07:00 is 2026-05-20T19:00Z — inside the range below by
    // instant, but lexically "…T12" sorts before the "…T15" start bound.
    await app.entries.log(t.id, { value: 7, occurred_at: day('20') });

    const buckets = await app.stats.bucket(
      t.id,
      { start: '2026-05-20T15:00:00.000Z', end: '2026-05-21T00:00:00.000Z' },
      'day',
    );

    expect(buckets.reduce((s, b) => s + b.value, 0)).toBe(7);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });
});

describe('StatsService.streak', () => {
  it('counts a current run ending today', async () => {
    const { app } = await makeTestApp(); // clock = 2026-05-25
    const t = await app.trackers.create({ name: 'Floss', kind: 'boolean' });
    for (const d of ['23', '24', '25']) {
      await app.entries.log(t.id, { value: 1, occurred_at: day(d) });
    }
    expect(await app.stats.streak(t.id)).toEqual({ current: 3, longest: 3 });
  });

  it('anchors to yesterday when today is not yet logged', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Floss', kind: 'boolean' });
    for (const d of ['23', '24']) {
      await app.entries.log(t.id, { value: 1, occurred_at: day(d) });
    }
    expect(await app.stats.streak(t.id)).toEqual({ current: 2, longest: 2 });
  });

  it('breaks the current run on a gap but keeps the longest', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Floss', kind: 'boolean' });
    for (const d of ['18', '19', '20', '25']) {
      await app.entries.log(t.id, { value: 1, occurred_at: day(d) });
    }
    expect(await app.stats.streak(t.id)).toEqual({ current: 1, longest: 3 });
  });

  it('returns zeroes for a tracker with no entries', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Empty' });
    expect(await app.stats.streak(t.id)).toEqual({ current: 0, longest: 0 });
  });
});

describe('StatsService.targetProgress', () => {
  it('sums all-time for reset_period "never"', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Books',
      kind: 'count',
      target: 10,
      reset_period: 'never',
    });
    await app.entries.log(t.id, { value: 4, occurred_at: day('01') });
    await app.entries.log(t.id, { value: 3, occurred_at: day('20') });

    const p = await app.stats.targetProgress(t.id);
    expect(p.target).toBe(10);
    expect(p.current).toBe(7);
    expect(p.ratio).toBeCloseTo(0.7);
  });

  it('scopes to the current period for a daily target and clamps ratio', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Water',
      kind: 'count',
      target: 2,
      reset_period: 'daily',
    });
    // Both logged "now" (today), so both count toward today's target.
    await app.entries.log(t.id, { value: 2 });
    await app.entries.log(t.id, { value: 3 });

    const p = await app.stats.targetProgress(t.id);
    expect(p.current).toBe(5);
    expect(p.ratio).toBe(1); // clamped
  });

  it('returns a null ratio when no target is set', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Mood', kind: 'number' });
    await app.entries.log(t.id, { value: 1 });
    const p = await app.stats.targetProgress(t.id);
    expect(p.target).toBeNull();
    expect(p.ratio).toBeNull();
    expect(p.current).toBe(1);
  });
});

describe('custom period windows', () => {
  // These tests turn on wall-clock hours, so they build timestamps in the
  // *host's* zone (like the app does) rather than the fixed -07:00 the rest
  // of this file uses — otherwise the hour a window opens on would shift.
  const at = (month: number, d: number, h: number, min = 0) =>
    toLocalISO(new Date(2026, month - 1, d, h, min, 0, 0));

  it("buckets months on the tracker's month_start_day", async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Rent',
      kind: 'number',
      month_start_day: 8,
    });
    expect(t.month_start_day).toBe(8);
    // May 3rd belongs to the window that opened April 8th; May 20th to May's.
    await app.entries.log(t.id, { value: 10, occurred_at: at(5, 3, 12) });
    await app.entries.log(t.id, { value: 4, occurred_at: at(5, 20, 12) });

    const buckets = await app.stats.bucket(
      t.id,
      { start: at(4, 8, 0), end: at(6, 8, 0) },
      'month',
    );
    expect(buckets.map((b) => [b.label, b.value])).toEqual([
      ['2026-04', 10],
      ['2026-05', 4],
    ]);
  });

  it("scopes target progress to the tracker's day window", async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Water',
      kind: 'number',
      reset_period: 'daily',
      target: 8,
      day_start_minute: 7 * 60, // a day runs 7:00 AM -> 6:59 AM
    });
    // Logged at 3:00 AM on the 25th — still the 24th's day…
    await app.entries.log(t.id, { value: 5, occurred_at: at(5, 25, 3) });

    // …so at 9:00 AM on the 25th, today's total is 0.
    expect((await app.stats.targetProgress(t.id, at(5, 25, 9))).current).toBe(0);
    // At 4:00 AM the same night it still counts.
    expect((await app.stats.targetProgress(t.id, at(5, 25, 4))).current).toBe(5);
  });

  it("counts streak days by the tracker's day window", async () => {
    const { app, setTime } = await makeTestApp();
    const t = await app.trackers.create({
      name: 'Journal',
      day_start_minute: 7 * 60,
    });
    // The last entry lands after midnight, which the window folds back into
    // the 24th — two logged days, not three.
    await app.entries.log(t.id, { value: 1, occurred_at: at(5, 23, 20) });
    await app.entries.log(t.id, { value: 1, occurred_at: at(5, 24, 20) });
    await app.entries.log(t.id, { value: 1, occurred_at: at(5, 25, 2) });

    setTime(at(5, 25, 3)); // still the 24th's day
    expect(await app.stats.streak(t.id)).toEqual({ current: 2, longest: 2 });
  });
});
