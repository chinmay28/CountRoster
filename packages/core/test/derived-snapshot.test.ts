import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';

/**
 * A derived *snapshot* tracker combines its sources' levels, best effort:
 * each source counts its latest reading at any instant, carried forward when
 * it has no newer one. "Net worth" = Checking + Brokerage, where Brokerage
 * has no May reading and its April one carries over.
 *
 * Readings (all mid-month so host-timezone bucketing can't move them):
 *   Checking:  1000 @ Mar 5 · 1200 @ Apr 20 · 1100 @ May 10
 *   Brokerage:  500 @ Apr 10
 */
async function netWorthSetup() {
  const ctx = await makeTestApp('2026-05-25T12:00:00.000-07:00');
  const { app } = ctx;
  const checking = await app.trackers.create({
    name: 'Checking',
    kind: 'number',
    is_snapshot: 1,
  });
  const brokerage = await app.trackers.create({
    name: 'Brokerage',
    kind: 'number',
    is_snapshot: 1,
  });

  await app.entries.log(checking.id, { value: 1000, occurred_at: '2026-03-05T10:00:00.000-07:00' });
  await app.entries.log(brokerage.id, { value: 500, occurred_at: '2026-04-10T10:00:00.000-07:00' });
  await app.entries.log(checking.id, { value: 1200, occurred_at: '2026-04-20T10:00:00.000-07:00' });
  await app.entries.log(checking.id, { value: 1100, occurred_at: '2026-05-10T10:00:00.000-07:00' });

  const netWorth = await app.trackers.create({
    name: 'Net worth',
    kind: 'number',
    is_snapshot: 1,
    links: [
      { source_id: checking.id, coefficient: 1 },
      { source_id: brokerage.id, coefficient: 1 },
    ],
  });

  return { ...ctx, checking, brokerage, netWorth };
}

describe('derived snapshot trackers', () => {
  it('can be created derived and snapshot at once', async () => {
    const { netWorth } = await netWorthSetup();
    expect(netWorth.is_derived).toBe(1);
    expect(netWorth.is_snapshot).toBe(1);
    expect(netWorth.reset_period).toBe('never');
  });

  it('effective entries are the combined level at each source reading', async () => {
    const { app, netWorth } = await netWorthSetup();
    const entries = await app.entries.forTracker(netWorth.id);
    // 1000 → (+Brokerage 500) 1500 → (Checking 1200) 1700 → (Checking 1100) 1600.
    expect(entries.map((e) => e.value)).toEqual([1000, 1500, 1700, 1600]);
    expect(entries.every((e) => e.tracker_id === netWorth.id)).toBe(true);
  });

  it('collapses several sources read at the same instant to one settled level', async () => {
    const ctx = await makeTestApp('2026-06-05T12:00:00.000-07:00');
    const { app } = ctx;
    const checking = await app.trackers.create({ name: 'Checking', kind: 'number', is_snapshot: 1 });
    const savings = await app.trackers.create({ name: 'Savings', kind: 'number', is_snapshot: 1 });
    const broker = await app.trackers.create({ name: 'Broker', kind: 'number', is_snapshot: 1 });
    // All three first recorded at the same instant (e.g. "as of today" balances).
    const ts = '2026-06-04T10:25:00.000-07:00';
    await app.entries.log(checking.id, { value: 66000, occurred_at: ts });
    await app.entries.log(savings.id, { value: 234000, occurred_at: ts });
    await app.entries.log(broker.id, { value: 1681284, occurred_at: ts });
    const netWorth = await app.trackers.create({
      name: 'Net worth',
      kind: 'number',
      is_snapshot: 1,
      links: [
        { source_id: checking.id, coefficient: 1 },
        { source_id: savings.id, coefficient: 1 },
        { source_id: broker.id, coefficient: 1 },
      ],
    });

    const entries = await app.entries.forTracker(netWorth.id);
    // One point per point in time: the combined level, not the partial sums
    // (66000 → 300000 → 1981284) the per-source join would otherwise emit.
    expect(entries.map((e) => e.value)).toEqual([1981284]);
  });

  it('targetProgress reads the current combined level, not a sum or last raw reading', async () => {
    const { app, netWorth } = await netWorthSetup();
    await app.trackers.update(netWorth.id, { target: 3200 });
    const progress = await app.stats.targetProgress(netWorth.id);
    // Latest per source: Checking 1100 + Brokerage 500 (carried from April).
    expect(progress.current).toBe(1600);
    expect(progress.ratio).toBe(0.5);
  });

  it('subtracts sources with negative coefficients from the level', async () => {
    const { app, checking } = await netWorthSetup();
    const loan = await app.trackers.create({
      name: 'Loan',
      kind: 'number',
      is_snapshot: 1,
    });
    await app.entries.log(loan.id, { value: 400, occurred_at: '2026-05-01T10:00:00.000-07:00' });
    const equity = await app.trackers.create({
      name: 'Equity',
      kind: 'number',
      is_snapshot: 1,
      links: [
        { source_id: checking.id, coefficient: 1 },
        { source_id: loan.id, coefficient: -1 },
      ],
    });
    const progress = await app.stats.targetProgress(equity.id);
    expect(progress.current).toBe(700); // 1100 − 400

    const slices = await app.stats.composition(equity.id);
    expect(slices.map((s) => s.total)).toEqual([1100, -400]);
  });

  it('buckets hold the combined level and carry it across empty periods', async () => {
    const { app, netWorth } = await netWorthSetup();
    const buckets = await app.stats.bucket(
      netWorth.id,
      { start: '2026-03-01T00:00:00.000-07:00', end: '2026-07-01T00:00:00.000-07:00' },
      'month',
    );
    // Host-timezone bucket edges may add empty buckets at either end, but the
    // populated ones are fixed, and every bucket after the last reading must
    // carry the final level (June has no readings — best effort carry-over).
    const populated = buckets.filter((b) => b.count > 0);
    expect(populated.map((b) => ({ value: b.value, count: b.count }))).toEqual([
      { value: 1000, count: 1 }, // March: Checking only
      { value: 1700, count: 2 }, // April: 1200 + 500, level at the last reading
      { value: 1600, count: 1 }, // May: 1100 + carried 500
    ]);
    const lastPopulated = buckets.indexOf(populated[populated.length - 1]!);
    const trailing = buckets.slice(lastPopulated + 1);
    expect(trailing.length).toBeGreaterThan(0);
    expect(trailing.every((b) => b.value === 1600 && b.count === 0)).toBe(true);
  });

  it('seeds the carried level from readings before the requested range', async () => {
    const { app, netWorth } = await netWorthSetup();
    // June only — every reading predates the range.
    const buckets = await app.stats.bucket(
      netWorth.id,
      { start: '2026-06-05T00:00:00.000-07:00', end: '2026-06-25T00:00:00.000-07:00' },
      'month',
    );
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((b) => b.value === 1600 && b.count === 0)).toBe(true);
  });

  it('an ordinary snapshot tracker also carries its level across empty buckets', async () => {
    const { app, checking } = await netWorthSetup();
    const buckets = await app.stats.bucket(
      checking.id,
      { start: '2026-02-01T00:00:00.000-07:00', end: '2026-07-01T00:00:00.000-07:00' },
      'month',
    );
    const populated = buckets.filter((b) => b.count > 0);
    expect(populated.map((b) => b.value)).toEqual([1000, 1200, 1100]);
    // Before the first reading there is nothing to carry…
    const firstPopulated = buckets.indexOf(populated[0]!);
    expect(buckets.slice(0, firstPopulated).every((b) => b.value === 0)).toBe(true);
    // …after the last one, the level persists.
    const lastPopulated = buckets.indexOf(populated[populated.length - 1]!);
    expect(
      buckets.slice(lastPopulated + 1).every((b) => b.value === 1100 && b.count === 0),
    ).toBe(true);
  });

  it('composition reports each source at its latest reading (all time)', async () => {
    const { app, checking, brokerage, netWorth } = await netWorthSetup();
    const slices = await app.stats.composition(netWorth.id);
    expect(slices).toEqual([
      {
        source_id: checking.id,
        name: 'Checking',
        color: checking.color,
        coefficient: 1,
        total: 1100,
        count: 3,
      },
      {
        source_id: brokerage.id,
        name: 'Brokerage',
        color: brokerage.color,
        coefficient: 1,
        total: 500,
        count: 1,
      },
    ]);
  });

  it('composition scoped to a window shows levels as of its end, carrying quiet sources', async () => {
    const { app, netWorth } = await netWorthSetup();

    // April: both sources read within the window.
    const april = await app.stats.composition(netWorth.id, {
      start: '2026-04-01T00:00:00.000-07:00',
      end: '2026-05-01T00:00:00.000-07:00',
    });
    expect(april.map((s) => [s.total, s.count])).toEqual([
      [1200, 1],
      [500, 1],
    ]);

    // May: Brokerage logged nothing — its April reading carries (count 0).
    const may = await app.stats.composition(netWorth.id, {
      start: '2026-05-01T00:00:00.000-07:00',
      end: '2026-06-01T00:00:00.000-07:00',
    });
    expect(may.map((s) => [s.total, s.count])).toEqual([
      [1100, 1],
      [500, 0],
    ]);

    // March: Brokerage hadn't started yet — a zero slice, best effort.
    const march = await app.stats.composition(netWorth.id, {
      start: '2026-03-01T00:00:00.000-07:00',
      end: '2026-04-01T00:00:00.000-07:00',
    });
    expect(march.map((s) => [s.total, s.count])).toEqual([
      [1000, 1],
      [0, 0],
    ]);
  });

  it('round-trips a derived snapshot through a backup', async () => {
    const { app } = await netWorthSetup();
    const bytes = await app.backup.exportBundle({ app_version: 'test' });
    const result = await app.backup.importBundle(bytes, { confirmOverwrite: true });
    expect(result.imported_rows.tracker_links).toBe(2);

    const trackers = await app.trackers.list();
    const restored = trackers.find((t) => t.name === 'Net worth')!;
    expect(restored.is_derived).toBe(1);
    expect(restored.is_snapshot).toBe(1);
    const progress = await app.stats.targetProgress(restored.id);
    expect(progress.current).toBe(1600);
  });
});
