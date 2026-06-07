import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import { NoteNotFoundError } from '../src/domain/notes.js';

describe('NoteService', () => {
  it('creates a note attached to a tracker', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Mood' });

    const note = await app.notes.create({
      tracker_id: t.id,
      body: 'Feeling alright today.',
    });

    expect(note.body).toBe('Feeling alright today.');
    expect(note.tracker_id).toBe(t.id);
    expect(note.entry_id).toBeNull();
  });

  it('creates a note attached to a specific entry', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Mood' });
    const e = await app.entries.log(t.id);

    const note = await app.notes.create({
      tracker_id: t.id,
      entry_id: e.id,
      body: 'Logged this in the afternoon.',
    });

    expect(note.entry_id).toBe(e.id);
  });

  it('edit() updates the body and records the previous version in note_edits', async () => {
    const { app, setTime } = await makeTestApp('2026-05-25T12:00:00.000-07:00');
    const t = await app.trackers.create({ name: 'Mood' });
    const created = await app.notes.create({ tracker_id: t.id, body: 'Felt off today.' });

    setTime('2026-05-25T13:00:00.000-07:00');
    const edited = await app.notes.edit(created.id, 'Felt better after a walk.');

    expect(edited.body).toBe('Felt better after a walk.');
    expect(edited.updated_at).not.toBe(created.updated_at);

    const history = await app.notes.history(created.id);
    expect(history.length).toBe(1);
    expect(history[0]!.prev_body).toBe('Felt off today.');
  });

  it('edit() appends to history across multiple edits', async () => {
    const { app, setTime } = await makeTestApp('2026-05-25T10:00:00.000-07:00');
    const t = await app.trackers.create({ name: 'X' });
    const n = await app.notes.create({ tracker_id: t.id, body: 'v1' });

    setTime('2026-05-25T11:00:00.000-07:00');
    await app.notes.edit(n.id, 'v2');

    setTime('2026-05-25T12:00:00.000-07:00');
    await app.notes.edit(n.id, 'v3');

    const history = await app.notes.history(n.id);
    expect(history.map((h) => h.prev_body)).toEqual(['v1', 'v2']);

    const current = await app.notes.get(n.id);
    expect(current?.body).toBe('v3');
  });

  it('edit() is a no-op (and writes no history) when body is unchanged', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    const n = await app.notes.create({ tracker_id: t.id, body: 'same' });

    await app.notes.edit(n.id, 'same');

    const history = await app.notes.history(n.id);
    expect(history.length).toBe(0);
  });

  it('edit() throws NoteNotFoundError for unknown id', async () => {
    const { app } = await makeTestApp();
    await expect(app.notes.edit('nope', 'x')).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
  });

  it('deleting a note cascades note_edits but does not touch the entry it was attached to', async () => {
    const { app, storage } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    const e = await app.entries.log(t.id);
    const n = await app.notes.create({
      tracker_id: t.id,
      entry_id: e.id,
      body: 'v1',
    });
    await app.notes.edit(n.id, 'v2');

    await app.notes.delete(n.id);

    const editRows = await storage.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM note_edits WHERE note_id = ?`,
      [n.id],
    );
    expect(editRows[0]!.c).toBe(0);

    // entry should still exist
    const stillThere = await app.entries.get(e.id);
    expect(stillThere).not.toBeNull();
  });

  it('deleting an entry that a note points to nulls out note.entry_id but keeps the note', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'X' });
    const e = await app.entries.log(t.id);
    const n = await app.notes.create({
      tracker_id: t.id,
      entry_id: e.id,
      body: 'v1',
    });

    await app.entries.delete(e.id);

    const reread = await app.notes.get(n.id);
    expect(reread).not.toBeNull();
    expect(reread!.entry_id).toBeNull();
    expect(reread!.body).toBe('v1');
  });

  it('update() can re-date a note without touching the edit history', async () => {
    const { app } = await makeTestApp();
    const t = await app.trackers.create({ name: 'Mood' });
    const n = await app.notes.create({ tracker_id: t.id, body: 'Note' });

    const moved = await app.notes.update(n.id, {
      occurred_at: '2026-05-01T09:00:00.000-07:00',
    });

    expect(moved.occurred_at).toBe('2026-05-01T09:00:00.000-07:00');
    expect(moved.body).toBe('Note');
    // Re-dating carries no prior content, so no audit row is written.
    expect(await app.notes.history(n.id)).toHaveLength(0);
  });

  it('update() changes body (audited) and occurred_at together', async () => {
    const { app, setTime } = await makeTestApp('2026-05-25T12:00:00.000-07:00');
    const t = await app.trackers.create({ name: 'Mood' });
    const n = await app.notes.create({ tracker_id: t.id, body: 'before' });

    setTime('2026-05-25T13:00:00.000-07:00');
    const updated = await app.notes.update(n.id, {
      body: 'after',
      occurred_at: '2026-04-01T08:00:00.000-07:00',
    });

    expect(updated.body).toBe('after');
    expect(updated.occurred_at).toBe('2026-04-01T08:00:00.000-07:00');
    const history = await app.notes.history(n.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.prev_body).toBe('before');
  });
});
