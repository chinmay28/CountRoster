import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { DerivedTrackerError } from '../src/domain/derived.js';

/**
 * A derived "Profit" tracker = Revenue (+1) − Expenses (−1). Builds the two
 * source trackers, logs some entries, and returns the test app.
 */
async function profitSetup() {
  const ctx = await makeTestApp('2026-05-25T12:00:00.000-07:00');
  const { app } = ctx;
  const revenue = await app.trackers.create({ name: 'Revenue', kind: 'number' });
  const expenses = await app.trackers.create({ name: 'Expenses', kind: 'number' });

  await app.entries.log(revenue.id, { value: 100, occurred_at: '2026-05-25T09:00:00.000-07:00' });
  await app.entries.log(revenue.id, { value: 50, occurred_at: '2026-05-25T11:00:00.000-07:00' });
  await app.entries.log(expenses.id, { value: 30, occurred_at: '2026-05-25T10:00:00.000-07:00' });

  const profit = await app.trackers.create({
    name: 'Profit',
    kind: 'number',
    links: [
      { source_id: revenue.id, coefficient: 1 },
      { source_id: expenses.id, coefficient: -1 },
    ],
  });

  return { ...ctx, revenue, expenses, profit };
}

describe('Derived trackers', () => {
  it('marks the tracker derived and stores its links', async () => {
    const { app, revenue, expenses, profit } = await profitSetup();
    expect(profit.is_derived).toBe(1);

    const links = await app.trackers.links(profit.id);
    expect(links.map((l) => [l.source_id, l.coefficient])).toEqual([
      [revenue.id, 1],
      [expenses.id, -1],
    ]);
  });

  it('ordinary trackers are not derived and have no links', async () => {
    const { app, revenue } = await profitSetup();
    expect(revenue.is_derived).toBe(0);
    expect(await app.trackers.links(revenue.id)).toEqual([]);
  });

  it('computes effective entries as the weighted combination of its sources', async () => {
    const { app, profit } = await profitSetup();
    const entries = await app.entries.forTracker(profit.id);

    // +100, +50 (revenue), −30 (expenses), ordered by occurred_at.
    expect(entries.map((e) => e.value)).toEqual([100, -30, 50]);
    const total = entries.reduce((sum, e) => sum + e.value, 0);
    expect(total).toBe(120); // 150 revenue − 30 expenses
  });

  it('reports the derived tracker as the owner of its virtual entries', async () => {
    const { app, profit } = await profitSetup();
    const entries = await app.entries.forTracker(profit.id);
    expect(entries.every((e) => e.tracker_id === profit.id)).toBe(true);
  });

  it('refuses to log directly on a derived tracker', async () => {
    const { app, profit } = await profitSetup();
    await expect(app.entries.log(profit.id, { value: 5 })).rejects.toBeInstanceOf(
      DerivedTrackerError,
    );
  });

  it('buckets the derived value per period', async () => {
    const { app, profit } = await profitSetup();
    const buckets = await app.stats.bucket(
      profit.id,
      { start: '2026-05-24T00:00:00.000-07:00', end: '2026-05-27T00:00:00.000-07:00' },
      'day',
    );
    // Bucket boundaries are host-local, so the entries may land in one or two
    // adjacent buckets depending on the runner's timezone; the weighted total
    // and entry count across the range are what matter.
    const total = buckets.reduce((s, b) => s + b.value, 0);
    const count = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(120);
    expect(count).toBe(3);
  });

  it('computes target progress against the derived total', async () => {
    const { app, profit } = await profitSetup();
    await app.trackers.update(profit.id, { target: 240 });
    const progress = await app.stats.targetProgress(
      profit.id,
      '2026-05-25T12:00:00.000-07:00',
    );
    expect(progress.current).toBe(120);
    expect(progress.target).toBe(240);
    expect(progress.ratio).toBeCloseTo(0.5);
  });

  it('streak reflects the days its sources were active', async () => {
    const { app, profit } = await profitSetup();
    const streak = await app.stats.streak(profit.id);
    expect(streak.longest).toBe(1);
  });

  it('setLinks replaces operands and can turn a tracker ordinary again', async () => {
    const { app, revenue, profit } = await profitSetup();

    await app.trackers.setLinks(profit.id, [{ source_id: revenue.id, coefficient: 2 }]);
    let entries = await app.entries.forTracker(profit.id);
    expect(entries.reduce((s, e) => s + e.value, 0)).toBe(300); // 2 × 150

    await app.trackers.setLinks(profit.id, []);
    const refreshed = await app.trackers.get(profit.id);
    expect(refreshed!.is_derived).toBe(0);
    entries = await app.entries.forTracker(profit.id);
    expect(entries).toEqual([]);
  });

  it('replaces links when update() is given a new links list', async () => {
    const { app, revenue, expenses, profit } = await profitSetup();
    await app.trackers.update(profit.id, {
      links: [{ source_id: expenses.id, coefficient: -2 }],
    });
    const links = await app.trackers.links(profit.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.source_id).toBe(expenses.id);
    expect(links[0]!.coefficient).toBe(-2);
    // The removed revenue source no longer contributes.
    const entries = await app.entries.forTracker(profit.id);
    expect(entries.reduce((s, e) => s + e.value, 0)).toBe(-60);
  });

  it('drops a link when its source tracker is deleted (cascade)', async () => {
    const { app, expenses, profit } = await profitSetup();
    await app.trackers.delete(expenses.id);
    const links = await app.trackers.links(profit.id);
    expect(links).toHaveLength(1); // only revenue remains
    const entries = await app.entries.forTracker(profit.id);
    expect(entries.reduce((s, e) => s + e.value, 0)).toBe(150); // revenue only
  });

  it('rejects a self-referential derivation', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Loop' });
    await expect(
      app.trackers.setLinks(t.id, [{ source_id: t.id, coefficient: 1 }]),
    ).rejects.toBeInstanceOf(DerivedTrackerError);
  });

  it('rejects a missing source tracker', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    await expect(
      app.trackers.setLinks(t.id, [{ source_id: 'does-not-exist', coefficient: 1 }]),
    ).rejects.toBeInstanceOf(DerivedTrackerError);
  });

  it('rejects nesting a derived tracker as a source', async () => {
    const { app, revenue, profit } = await profitSetup();
    const meta = await app.trackers.create({ name: 'Meta' });
    await expect(
      app.trackers.setLinks(meta.id, [
        { source_id: revenue.id, coefficient: 1 },
        { source_id: profit.id, coefficient: 1 },
      ]),
    ).rejects.toBeInstanceOf(DerivedTrackerError);
  });

  it('rejects duplicate sources in a single derivation', async () => {
    const { app, revenue } = await profitSetup();
    const t = await app.trackers.create({ name: 'Dup' });
    await expect(
      app.trackers.setLinks(t.id, [
        { source_id: revenue.id, coefficient: 1 },
        { source_id: revenue.id, coefficient: 2 },
      ]),
    ).rejects.toBeInstanceOf(DerivedTrackerError);
  });

  it('survives a backup round-trip with links intact', async () => {
    const { app, storage } = await profitSetup();
    const bytes = await app.backup.exportBundle({ app_version: 'test' });

    // Wipe and re-import into a fresh app over the same storage.
    const result = await app.backup.importBundle(bytes, { confirmOverwrite: true });
    expect(result.imported_rows.tracker_links).toBe(2);

    const trackers = await app.trackers.list();
    const restored = trackers.find((t) => t.name === 'Profit')!;
    expect(restored.is_derived).toBe(1);
    const entries = await app.entries.forTracker(restored.id);
    expect(entries.reduce((s, e) => s + e.value, 0)).toBe(120);
    void storage;
  });
});
