import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';

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
