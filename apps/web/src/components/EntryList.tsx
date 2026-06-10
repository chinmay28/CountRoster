import { useState } from 'react';
import type { Entry, Note, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { NoteHistory } from './NoteItem.tsx';
import {
  formatValue,
  formatDateTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';

interface EntryListProps {
  tracker: Tracker;
  entries: Entry[];
  /** Notes linked to an entry, keyed by `entry_id`. */
  notesByEntry?: Map<string, Note[]>;
  onChanged: () => void;
  /**
   * Render entries without edit/delete controls. Used for derived trackers,
   * whose entries are virtual (computed from their sources) and not editable.
   */
  readOnly?: boolean;
}

/** Recent entries with a single inline edit (value, backdate, and the one note
 * describing the entry) and delete. The entry's note is shown right beneath it. */
export function EntryList({
  tracker,
  entries,
  notesByEntry,
  onChanged,
  readOnly = false,
}: EntryListProps) {
  if (entries.length === 0) {
    return <p className="muted">No entries yet.</p>;
  }
  return (
    <ul className="entry-list">
      {entries
        .slice()
        .reverse()
        .map((entry, i) => (
          <EntryRow
            key={readOnly ? `${entry.id}-${i}` : entry.id}
            tracker={tracker}
            entry={entry}
            note={notesByEntry?.get(entry.id)?.[0] ?? null}
            onChanged={onChanged}
            readOnly={readOnly}
          />
        ))}
    </ul>
  );
}

function EntryRow({
  tracker,
  entry,
  note,
  onChanged,
  readOnly,
}: {
  tracker: Tracker;
  entry: Entry;
  /** The single note describing this entry, if any. */
  note: Note | null;
  onChanged: () => void;
  readOnly: boolean;
}) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.value));
  const [when, setWhen] = useState(toDatetimeLocalValue(entry.occurred_at));
  const [noteBody, setNoteBody] = useState(note?.body ?? '');
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  function startEditing() {
    setValue(String(entry.value));
    setWhen(toDatetimeLocalValue(entry.occurred_at));
    setNoteBody(note?.body ?? '');
    setShowHistory(false);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      const occurredAt = fromDatetimeLocalValue(when);
      await core.entries.update(entry.id, {
        value: Number(value),
        occurred_at: occurredAt,
      });
      // A single note per entry, edited right here in the entry's edit flow.
      const body = noteBody.trim();
      if (note) {
        if (!body) {
          await core.notes.delete(note.id);
        } else if (body !== note.body) {
          await core.notes.update(note.id, { body });
        }
      } else if (body) {
        await core.notes.create({
          tracker_id: tracker.id,
          entry_id: entry.id,
          body,
          occurred_at: occurredAt,
        });
      }
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Delete this entry?')) return;
    setBusy(true);
    try {
      await core.entries.delete(entry.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="entry entry--editing">
        <div className="entry__edit-fields">
          <input
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        <textarea
          className="entry__note-input"
          rows={2}
          placeholder="Note (optional)…"
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
        />
        <div className="entry__actions">
          {note && (
            <button
              className="btn btn--small"
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
            >
              History
            </button>
          )}
          <button className="btn btn--small" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--small btn--primary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
        {note && showHistory && <NoteHistory noteId={note.id} />}
      </li>
    );
  }

  return (
    <li className="entry">
      <div className="entry__main">
        <span className="entry__value">{formatValue(tracker, entry.value)}</span>
        <span className="entry__time muted">{formatDateTime(entry.occurred_at)}</span>
        {!readOnly && (
          <div className="entry__actions">
            <button className="btn btn--small" onClick={startEditing}>
              Edit
            </button>
            <button className="btn btn--small btn--danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>

      {note && <p className="entry__note">{note.body}</p>}
    </li>
  );
}
