import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { manifestSchema } from '../src/backup/manifest.js';
import { unzip } from '../src/backup/zip.js';

const decoder = new TextDecoder();

async function seed() {
  const t = await makeTestApp();
  const tracker = await t.app.trackers.create({ name: 'Coffee', target: 3 });
  await t.app.entries.log(tracker.id, { value: 1 });
  await t.app.entries.log(tracker.id, { value: 2 });
  const note = await t.app.notes.create({ tracker_id: tracker.id, body: 'first' });
  await t.app.notes.edit(note.id, 'second');
  const group = await t.app.groups.create({ name: 'Morning' });
  await t.app.groups.addTracker(group.id, tracker.id);
  await t.app.reminders.create({ tracker_id: tracker.id, time_minute: 480 });
  return { ...t, tracker };
}

describe('BackupService', () => {
  it('buildManifest reports row counts and a tables checksum', async () => {
    const { app } = await seed();
    const manifest = await app.backup.buildManifest({ app_version: '1.2.3' });
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
    expect(manifest.app_version).toBe('1.2.3');
    expect(manifest.row_counts.trackers).toBe(1);
    expect(manifest.row_counts.entries).toBe(2);
    expect(manifest.row_counts.note_edits).toBe(1);
    expect(manifest.checksums.tables).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('exportBundle produces a readable zip with manifest, all.json, and CSVs', async () => {
    const { app } = await seed();
    const bytes = await app.backup.exportBundle({ app_version: '1.0.0' });
    const files = unzip(bytes);

    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('all.json')).toBe(true);
    expect(files.has('exports/trackers.csv')).toBe(true);
    expect(files.has('exports/entries.csv')).toBe(true);

    const trackersCsv = decoder.decode(files.get('exports/trackers.csv')!);
    expect(trackersCsv.split('\r\n')[0]).toContain('name');
    expect(trackersCsv).toContain('Coffee');
  });

  it('round-trips: export from one DB, import into a fresh DB', async () => {
    const { app } = await seed();
    const bytes = await app.backup.exportBundle({ app_version: '1.0.0' });

    const dest = await makeTestApp();
    const result = await dest.app.backup.importBundle(bytes);
    expect(result.imported_rows.trackers).toBe(1);
    expect(result.imported_rows.entries).toBe(2);

    const trackers = await dest.app.trackers.list();
    expect(trackers.map((t) => t.name)).toEqual(['Coffee']);
    const entries = await dest.app.entries.forTracker(trackers[0]!.id);
    expect(entries.map((e) => e.value).sort()).toEqual([1, 2]);
    const noteHistory = await dest.app.notes.forTracker(trackers[0]!.id);
    expect(noteHistory[0]!.body).toBe('second');
  });

  it('refuses to overwrite a non-empty DB without confirmOverwrite', async () => {
    const { app } = await seed();
    const bytes = await app.backup.exportBundle({ app_version: '1.0.0' });
    // Importing back into the same (non-empty) DB should be refused.
    await expect(app.backup.importBundle(bytes)).rejects.toThrow(/non-empty/);
    // With the flag it succeeds.
    const ok = await app.backup.importBundle(bytes, { confirmOverwrite: true });
    expect(ok.imported_rows.trackers).toBe(1);
  });

  it('detects a corrupted tables payload via checksum', async () => {
    const { app } = await seed();
    const bytes = await app.backup.exportBundle({ app_version: '1.0.0' });

    // Tamper with the all.json content inside the (stored) zip. Use a
    // same-length replacement so the zip offsets stay valid and it's the
    // tables checksum — not a structural error — that rejects the import.
    const text = decoder.decode(bytes);
    const tampered = text.replace('Coffee', 'Teaaaa');
    const tamperedBytes = new TextEncoder().encode(tampered);

    const dest = await makeTestApp();
    await expect(dest.app.backup.importBundle(tamperedBytes)).rejects.toThrow();
  });
});
