import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { TrackerNotFoundError } from '../src/domain/trackers.js';
import { DerivedTrackerError } from '../src/domain/derived.js';
import { FieldNotFoundError, FieldValueError } from '../src/domain/fields.js';
import type { CountRosterCore } from '../src/createApp.js';

// The running example is the one custom fields were added for: a milk-feeding
// tracker whose primary value is the volume, carrying "Feed type" (a choice)
// and "Wet diaper" (a flag) alongside every feed.
async function feedingTracker(app: CountRosterCore) {
  const tracker = await app.trackers.create({ name: 'Milk', kind: 'number', unit: 'ml' });
  const fields = await app.fields.replace(tracker.id, [
    {
      name: 'Feed type',
      kind: 'choice',
      options: [
        { label: 'Bottle', color: '#4ECDC4' },
        { label: 'Formula' },
        { label: 'Breast' },
      ],
    },
    { name: 'Wet diaper', kind: 'flag' },
  ]);
  return { tracker, feedType: fields[0]!, wetDiaper: fields[1]! };
}

describe('FieldService', () => {
  it('replace() creates fields with their options, in order', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);

    expect(feedType.name).toBe('Feed type');
    expect(feedType.kind).toBe('choice');
    expect(feedType.unit).toBeNull();
    expect(feedType.options.map((o) => o.label)).toEqual(['Bottle', 'Formula', 'Breast']);
    expect(feedType.options[0]!.color).toBe('#4ECDC4');
    expect(feedType.options[1]!.color).toBeNull();
    // sort_order comes from position in the payload, not the caller.
    expect([feedType.sort_order, wetDiaper.sort_order]).toEqual([0, 1]);
    expect(wetDiaper.options).toEqual([]);

    expect(await app.fields.list(tracker.id)).toEqual([feedType, wetDiaper]);
  });

  it('replace() rejects a choice field with no options, and options elsewhere', async () => {
    const { app } = await makeTestApp();
    const tracker = await app.trackers.create({ name: 'Milk' });

    await expect(
      app.fields.replace(tracker.id, [{ name: 'Feed type', kind: 'choice' } as never]),
    ).rejects.toThrow();
    await expect(
      app.fields.replace(tracker.id, [
        { name: 'Wet diaper', kind: 'flag', options: [{ label: 'Yes' }] } as never,
      ]),
    ).rejects.toThrow();
  });

  it('replace() refuses unknown and derived trackers', async () => {
    const { app } = await makeTestApp();
    const source = await app.trackers.create({ name: 'Milk' });
    const derived = await app.trackers.create({
      name: 'Total',
      links: [{ source_id: source.id, coefficient: 1 }],
    });

    const field = [{ name: 'Note', kind: 'text' }] as never;
    await expect(app.fields.replace('nope', field)).rejects.toBeInstanceOf(
      TrackerNotFoundError,
    );
    await expect(app.fields.replace(derived.id, field)).rejects.toBeInstanceOf(
      DerivedTrackerError,
    );
  });

  it('replace() keeps fields named by id and prunes the rest', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);
    const entry = await app.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: feedType.options[0]!.id, [wetDiaper.id]: true },
    });

    const after = await app.fields.replace(tracker.id, [
      {
        id: feedType.id,
        name: 'How fed',
        kind: 'choice',
        options: [
          { id: feedType.options[0]!.id, label: 'Bottle' },
          { id: feedType.options[1]!.id, label: 'Formula' },
        ],
      },
    ]);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(feedType.id);
    expect(after[0]!.name).toBe('How fed');
    expect(after[0]!.options).toHaveLength(2);

    // The kept field's answer survived; the dropped field's went with it.
    const reloaded = await app.entries.get(entry.id);
    expect(reloaded!.fields).toHaveLength(1);
    expect(reloaded!.fields[0]!.option_id).toBe(feedType.options[0]!.id);
  });

  it('replace() clears answers when a field changes kind', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType } = await feedingTracker(app);
    const entry = await app.entries.log(tracker.id, {
      fields: { [feedType.id]: feedType.options[0]!.id },
    });

    await app.fields.replace(tracker.id, [
      { id: feedType.id, name: 'Feed type', kind: 'text' },
    ]);
    expect((await app.entries.get(entry.id))!.fields).toEqual([]);
  });
});

describe('entry field answers', () => {
  it('log() stores answers in the column its field kind dictates', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);

    const entry = await app.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: feedType.options[0]!.id, [wetDiaper.id]: true },
    });
    expect(entry.fields).toHaveLength(2);
    // Ordered by the owning field's sort order, not insertion.
    expect(entry.fields[0]!.field_id).toBe(feedType.id);
    expect(entry.fields[0]!.option_id).toBe(feedType.options[0]!.id);
    expect(entry.fields[0]!.number_value).toBeNull();
    expect(entry.fields[0]!.text_value).toBeNull();
    expect(entry.fields[1]!.number_value).toBe(1);

    expect((await app.entries.get(entry.id))!.fields).toHaveLength(2);
    const listed = await app.entries.forTracker(tracker.id);
    expect(listed[0]!.fields).toHaveLength(2);

    // An entry with no answers reports an empty array, never undefined.
    const bare = await app.entries.log(tracker.id, { value: 60 });
    expect(bare.fields).toEqual([]);
  });

  it('log() rejects answers that do not match their field', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);

    await expect(
      app.entries.log(tracker.id, { fields: { nope: 'x' } }),
    ).rejects.toBeInstanceOf(FieldValueError);
    await expect(
      app.entries.log(tracker.id, { fields: { [feedType.id]: 'not-an-option' } }),
    ).rejects.toBeInstanceOf(FieldValueError);
    await expect(
      app.entries.log(tracker.id, { fields: { [wetDiaper.id]: 2 } }),
    ).rejects.toBeInstanceOf(FieldValueError);

    // A rejected answer must not leave the entry behind.
    expect(await app.entries.forTracker(tracker.id)).toHaveLength(0);
  });

  it('a flag takes booleans and 0|1 alike', async () => {
    const { app } = await makeTestApp();
    const { tracker, wetDiaper } = await feedingTracker(app);

    for (const raw of [false, 0] as const) {
      const entry = await app.entries.log(tracker.id, { fields: { [wetDiaper.id]: raw } });
      expect(entry.fields[0]!.number_value).toBe(0);
    }
  });

  // Leaving a field blank is always allowed. This is what keeps fields
  // backward compatible: adding one can't invalidate the entries logged
  // before it existed, and every write path that predates it keeps working.
  it('always accepts an unanswered field', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);

    // A bare log — the shape every client sent before fields existed.
    const bare = await app.entries.log(tracker.id, { value: 120 });
    expect(bare.fields).toEqual([]);
    // An empty answer map, and a partial one, are equally fine.
    await expect(app.entries.log(tracker.id, { value: 60, fields: {} })).resolves.toBeTruthy();
    const partial = await app.entries.log(tracker.id, {
      value: 90,
      fields: { [feedType.id]: feedType.options[0]!.id },
    });
    expect(partial.fields).toHaveLength(1);

    // Every answer on an entry can be cleared back to blank.
    const full = await app.entries.log(tracker.id, {
      value: 30,
      fields: { [feedType.id]: feedType.options[0]!.id, [wetDiaper.id]: true },
    });
    const cleared = await app.entries.update(full.id, {
      fields: { [feedType.id]: null, [wetDiaper.id]: null },
    });
    expect(cleared.fields).toEqual([]);

    // Adding a field to a tracker that already has entries leaves them valid
    // and editable — they simply read as unanswered.
    const fields = await app.fields.replace(tracker.id, [
      {
        id: feedType.id,
        name: 'Feed type',
        kind: 'choice',
        options: [{ id: feedType.options[0]!.id, label: 'Bottle' }],
      },
      { id: wetDiaper.id, name: 'Wet diaper', kind: 'flag' },
      { name: 'Side', kind: 'choice', options: [{ label: 'Left' }] },
    ]);
    await expect(app.entries.update(bare.id, { value: 125 })).resolves.toBeTruthy();

    const slices = await app.stats.fieldBreakdown(tracker.id, fields[2]!.id);
    expect(slices.at(-1)).toMatchObject({ key: '', label: 'Not set', count: 4 });
  });

  it('update() rewrites only the answers it names', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);
    const entry = await app.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: feedType.options[0]!.id, [wetDiaper.id]: 1 },
    });

    const updated = await app.entries.update(entry.id, {
      value: 150,
      fields: { [feedType.id]: feedType.options[2]!.id },
    });
    expect(updated.value).toBe(150);
    expect(updated.fields).toHaveLength(2);
    expect(updated.fields[0]!.option_id).toBe(feedType.options[2]!.id);

    const cleared = await app.entries.update(entry.id, { fields: { [wetDiaper.id]: null } });
    expect(cleared.fields).toHaveLength(1);
    expect(cleared.fields[0]!.field_id).toBe(feedType.id);
  });

  it('logMany() carries answers and rolls the batch back on a bad one', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);

    const entries = await app.entries.logMany([
      { tracker_id: tracker.id, value: 120, fields: { [feedType.id]: feedType.options[0]!.id } },
      { tracker_id: tracker.id, value: 60, fields: { [wetDiaper.id]: true } },
    ]);
    expect(entries[0]!.fields[0]!.option_id).toBe(feedType.options[0]!.id);
    expect(entries[1]!.fields[0]!.number_value).toBe(1);

    await expect(
      app.entries.logMany([
        { tracker_id: tracker.id, value: 10 },
        { tracker_id: tracker.id, value: 20, fields: { [feedType.id]: 'bogus' } },
      ]),
    ).rejects.toBeInstanceOf(FieldValueError);
    expect(await app.entries.forTracker(tracker.id)).toHaveLength(2);
  });

  it('deleting an entry cascades its answers', async () => {
    const { app, storage } = await makeTestApp();
    const { tracker, feedType } = await feedingTracker(app);
    const entry = await app.entries.log(tracker.id, {
      fields: { [feedType.id]: feedType.options[0]!.id },
    });

    await app.entries.delete(entry.id);
    const rows = await storage.query(
      `SELECT id FROM entry_field_values WHERE entry_id = ?`,
      [entry.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('stats.fieldBreakdown()', () => {
  it('splits a total across a choice field, keeping empty options and blanks apart', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType, wetDiaper } = await feedingTracker(app);
    const [bottle, formula, breast] = feedType.options;

    await app.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: bottle!.id, [wetDiaper.id]: true },
    });
    await app.entries.log(tracker.id, {
      value: 80,
      fields: { [feedType.id]: bottle!.id, [wetDiaper.id]: false },
    });
    await app.entries.log(tracker.id, { value: 50, fields: { [feedType.id]: breast!.id } });
    await app.entries.log(tracker.id, { value: 30 });

    const slices = await app.stats.fieldBreakdown(tracker.id, feedType.id);
    expect(slices).toEqual([
      { field_id: feedType.id, key: bottle!.id, label: 'Bottle', color: '#4ECDC4', total: 200, count: 2 },
      { field_id: feedType.id, key: formula!.id, label: 'Formula', color: null, total: 0, count: 0 },
      { field_id: feedType.id, key: breast!.id, label: 'Breast', color: null, total: 50, count: 1 },
      { field_id: feedType.id, key: '', label: 'Not set', color: null, total: 30, count: 1 },
    ]);

    // A flag splits Yes/No, with unanswered feeds kept out of the explicit No.
    const flags = await app.stats.fieldBreakdown(tracker.id, wetDiaper.id);
    expect(flags.map((s) => [s.label, s.total, s.count])).toEqual([
      ['Yes', 120, 1],
      ['No', 80, 1],
      ['Not set', 80, 2],
    ]);
  });

  it('honors a range and refuses fields it cannot break down', async () => {
    const { app } = await makeTestApp();
    const { tracker, feedType } = await feedingTracker(app);
    const bottle = feedType.options[0]!;

    await app.entries.log(tracker.id, {
      value: 100,
      occurred_at: '2026-05-24T09:00:00.000-07:00',
      fields: { [feedType.id]: bottle.id },
    });
    await app.entries.log(tracker.id, {
      value: 40,
      occurred_at: '2026-05-25T09:00:00.000-07:00',
      fields: { [feedType.id]: bottle.id },
    });

    const scoped = await app.stats.fieldBreakdown(tracker.id, feedType.id, {
      start: '2026-05-25T00:00:00.000-07:00',
      end: '2026-05-26T00:00:00.000-07:00',
    });
    expect([scoped[0]!.total, scoped[0]!.count]).toEqual([40, 1]);

    await expect(
      app.stats.fieldBreakdown(tracker.id, 'nope'),
    ).rejects.toBeInstanceOf(FieldNotFoundError);

    // A field belonging to another tracker is not this tracker's to break down.
    const other = await app.trackers.create({ name: 'Sleep' });
    const [where] = await app.fields.replace(other.id, [{ name: 'Where', kind: 'text' }]);
    await expect(
      app.stats.fieldBreakdown(tracker.id, where!.id),
    ).rejects.toBeInstanceOf(FieldNotFoundError);

    const [minutes] = await app.fields.replace(other.id, [
      { name: 'Minutes', kind: 'number' },
    ]);
    await expect(
      app.stats.fieldBreakdown(other.id, minutes!.id),
    ).rejects.toBeInstanceOf(FieldValueError);
  });

  it('orders a text breakdown by size, with blank text counting as unanswered', async () => {
    const { app } = await makeTestApp();
    const tracker = await app.trackers.create({ name: 'Sleep', kind: 'duration' });
    const [where] = await app.fields.replace(tracker.id, [{ name: 'Where', kind: 'text' }]);

    await app.entries.log(tracker.id, { value: 30, fields: { [where!.id]: 'crib' } });
    await app.entries.log(tracker.id, { value: 90, fields: { [where!.id]: 'stroller' } });
    await app.entries.log(tracker.id, { value: 20, fields: { [where!.id]: 'crib' } });
    await app.entries.log(tracker.id, { value: 5, fields: { [where!.id]: '   ' } });

    const slices = await app.stats.fieldBreakdown(tracker.id, where!.id);
    expect(slices.map((s) => [s.label, s.total, s.count])).toEqual([
      ['stroller', 90, 1],
      ['crib', 50, 2],
      ['Not set', 5, 1],
    ]);
  });
});
