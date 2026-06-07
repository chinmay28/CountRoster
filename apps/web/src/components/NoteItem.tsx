import { useState } from 'react';
import type { Note, NoteEdit } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import {
  formatDateTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';

/**
 * A single journal note: view, edit (body *and* date/time), delete, and edit
 * history. Used standalone in the Notes section and inline under the entry a
 * note describes.
 */
export function NoteItem({ note, onChanged }: { note: Note; onChanged: () => void }) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [when, setWhen] = useState(toDatetimeLocalValue(note.occurred_at));
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  function startEditing() {
    setBody(note.body);
    setWhen(toDatetimeLocalValue(note.occurred_at));
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      await core.notes.update(note.id, {
        body: body.trim(),
        occurred_at: fromDatetimeLocalValue(when),
      });
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

  if (editing) {
    return (
      <li className="note note--editing">
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="field">
          <span>When</span>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <div className="note__actions">
          <button className="btn" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="note">
      <p className="note__body">{note.body}</p>
      <div className="note__meta">
        <span className="muted">{formatDateTime(note.occurred_at)}</span>
        <div className="note__actions">
          <button className="btn btn--small" onClick={startEditing}>
            Edit
          </button>
          <button className="btn btn--small" onClick={() => setShowHistory((s) => !s)}>
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
