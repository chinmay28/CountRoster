import { useState } from 'react';
import type { Note, NoteEdit } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatDateTime } from '../lib/format.ts';

/** Journal notes for a tracker, with add / edit / delete and edit history. */
export function NotesSection({ trackerId }: { trackerId: string }) {
  const core = useCore();
  const { data: notes, loading, error, reload } = useAsync(
    () => core.notes.forTracker(trackerId),
    [trackerId],
  );

  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setAdding(true);
    try {
      await core.notes.create({ tracker_id: trackerId, body: draft.trim() });
      setDraft('');
      reload();
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="notes">
      <h2>Notes</h2>

      <form className="notes__add" onSubmit={addNote}>
        <textarea
          rows={2}
          placeholder="Add a note…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={adding || !draft.trim()}
        >
          Add note
        </button>
      </form>

      {loading && <p className="muted">Loading notes…</p>}
      {error && <p className="error">{error.message}</p>}

      {notes && notes.length === 0 && (
        <p className="muted">No notes yet.</p>
      )}

      <ul className="notes__list">
        {notes
          ?.slice()
          .reverse()
          .map((note) => (
            <NoteItem key={note.id} note={note} onChanged={reload} />
          ))}
      </ul>
    </section>
  );
}

function NoteItem({ note, onChanged }: { note: Note; onChanged: () => void }) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await core.notes.edit(note.id, body.trim());
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Delete this note?')) return;
    setBusy(true);
    try {
      await core.notes.delete(note.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="note">
      {editing ? (
        <>
          <textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="note__actions">
            <button
              className="btn"
              onClick={() => {
                setBody(note.body);
                setEditing(false);
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn btn--primary" onClick={save} disabled={busy}>
              Save
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="note__body">{note.body}</p>
          <div className="note__meta">
            <span className="muted">{formatDateTime(note.occurred_at)}</span>
            <div className="note__actions">
              <button className="btn btn--small" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="btn btn--small"
                onClick={() => setShowHistory((s) => !s)}
              >
                History
              </button>
              <button
                className="btn btn--small btn--danger"
                onClick={remove}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          </div>
          {showHistory && <NoteHistory noteId={note.id} />}
        </>
      )}
    </li>
  );
}

function NoteHistory({ noteId }: { noteId: string }) {
  const core = useCore();
  const { data, loading, error } = useAsync<NoteEdit[]>(
    () => core.notes.history(noteId),
    [noteId],
  );

  if (loading) return <p className="muted">Loading history…</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (!data || data.length === 0) {
    return <p className="muted note__history-empty">No previous versions.</p>;
  }

  return (
    <ol className="note__history">
      {data
        .slice()
        .reverse()
        .map((edit) => (
          <li key={edit.id}>
            <span className="muted">{formatDateTime(edit.edited_at)}</span>
            <blockquote>{edit.prev_body}</blockquote>
          </li>
        ))}
    </ol>
  );
}
