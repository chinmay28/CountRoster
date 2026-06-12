import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { DerivedTrackerError } from '../src/domain/derived.js';

describe('hidden trackers', () => {
  it('creates visible trackers by default', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Water' });
    expect(t.is_hidden).toBe(0);
  });

  it('creates a hidden tracker when asked', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Secret', is_hidden: 1 });
    expect(t.is_hidden).toBe(1);
  });

  it('list excludes hidden trackers unless includeHidden is set', async () => {
    const { app } = await makeTestApp();
    const visible = await app.trackers.create({ name: 'Visible' });
    const hidden = await app.trackers.create({ name: 'Hidden', is_hidden: 1 });

    const def = await app.trackers.list();
    expect(def.map((t) => t.id)).toEqual([visible.id]);

    const all = await app.trackers.list({ includeHidden: true });
    expect(all.map((t) => t.id).sort()).toEqual([visible.id, hidden.id].sort());
  });

  it('includeHidden composes with includeArchived', async () => {
    const { app } = await makeTestApp();
    const hidden = await app.trackers.create({ name: 'Hidden', is_hidden: 1 });
    await app.trackers.archive(hidden.id);

    expect(await app.trackers.list({ includeArchived: true })).toEqual([]);
    expect(await app.trackers.list({ includeHidden: true })).toEqual([]);
    const both = await app.trackers.list({ includeArchived: true, includeHidden: true });
    expect(both.map((t) => t.id)).toEqual([hidden.id]);
  });

  it('can hide and unhide via update()', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Coffee' });

    const hidden = await app.trackers.update(t.id, { is_hidden: 1 });
    expect(hidden.is_hidden).toBe(1);
    expect((await app.trackers.list()).map((x) => x.id)).not.toContain(t.id);

    const visible = await app.trackers.update(t.id, { is_hidden: 0 });
    expect(visible.is_hidden).toBe(0);
    expect((await app.trackers.list()).map((x) => x.id)).toContain(t.id);
  });

  describe('derivations cannot mix hidden and visible trackers', () => {
    it('rejects a hidden derived tracker over visible sources', async () => {
      const { app } = await makeTestApp();
      const source = await app.trackers.create({ name: 'Revenue', kind: 'number' });
      await expect(
        app.trackers.create({
          name: 'Secret profit',
          kind: 'number',
          is_hidden: 1,
          links: [{ source_id: source.id, coefficient: 1 }],
        }),
      ).rejects.toBeInstanceOf(DerivedTrackerError);
    });

    it('rejects a visible derived tracker over a hidden source', async () => {
      const { app } = await makeTestApp();
      const source = await app.trackers.create({
        name: 'Secret revenue',
        kind: 'number',
        is_hidden: 1,
      });
      await expect(
        app.trackers.create({
          name: 'Profit',
          kind: 'number',
          links: [{ source_id: source.id, coefficient: 1 }],
        }),
      ).rejects.toBeInstanceOf(DerivedTrackerError);
    });

    it('allows a hidden derived tracker over hidden sources', async () => {
      const { app } = await makeTestApp();
      const a = await app.trackers.create({ name: 'A', kind: 'number', is_hidden: 1 });
      const b = await app.trackers.create({ name: 'B', kind: 'number', is_hidden: 1 });
      const derived = await app.trackers.create({
        name: 'A minus B',
        kind: 'number',
        is_hidden: 1,
        links: [
          { source_id: a.id, coefficient: 1 },
          { source_id: b.id, coefficient: -1 },
        ],
      });
      expect(derived.is_derived).toBe(1);
      expect(derived.is_hidden).toBe(1);

      await app.entries.log(a.id, { value: 5 });
      await app.entries.log(b.id, { value: 2 });
      const entries = await app.entries.forTracker(derived.id);
      expect(entries.map((e) => e.value).sort()).toEqual([-2, 5]);
    });

    it('rejects setLinks() to a source of the other visibility', async () => {
      const { app } = await makeTestApp();
      const hiddenSource = await app.trackers.create({ name: 'H', is_hidden: 1 });
      const derived = await app.trackers.create({ name: 'D', kind: 'number' });
      await expect(
        app.trackers.setLinks(derived.id, [{ source_id: hiddenSource.id, coefficient: 1 }]),
      ).rejects.toBeInstanceOf(DerivedTrackerError);
    });

    it('rejects hiding a source whose derived tracker stays visible', async () => {
      const { app } = await makeTestApp();
      const source = await app.trackers.create({ name: 'Revenue', kind: 'number' });
      await app.trackers.create({
        name: 'Profit',
        kind: 'number',
        links: [{ source_id: source.id, coefficient: 1 }],
      });
      await expect(
        app.trackers.update(source.id, { is_hidden: 1 }),
      ).rejects.toBeInstanceOf(DerivedTrackerError);
    });

    it('rejects unhiding only the derived tracker of a hidden derivation', async () => {
      const { app } = await makeTestApp();
      const source = await app.trackers.create({ name: 'H', kind: 'number', is_hidden: 1 });
      const derived = await app.trackers.create({
        name: 'D',
        kind: 'number',
        is_hidden: 1,
        links: [{ source_id: source.id, coefficient: 1 }],
      });
      await expect(
        app.trackers.update(derived.id, { is_hidden: 0 }),
      ).rejects.toBeInstanceOf(DerivedTrackerError);
    });

    it('allows unhiding the derived tracker while replacing its sources with visible ones', async () => {
      const { app } = await makeTestApp();
      const hiddenSource = await app.trackers.create({ name: 'H', kind: 'number', is_hidden: 1 });
      const visibleSource = await app.trackers.create({ name: 'V', kind: 'number' });
      const derived = await app.trackers.create({
        name: 'D',
        kind: 'number',
        is_hidden: 1,
        links: [{ source_id: hiddenSource.id, coefficient: 1 }],
      });
      const updated = await app.trackers.update(derived.id, {
        is_hidden: 0,
        links: [{ source_id: visibleSource.id, coefficient: 1 }],
      });
      expect(updated.is_hidden).toBe(0);
      const links = await app.trackers.links(derived.id);
      expect(links.map((l) => l.source_id)).toEqual([visibleSource.id]);
    });
  });
});
