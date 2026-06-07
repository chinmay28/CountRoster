import { useState } from 'react';
import type { Entry, Note, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { NoteItem } from './NoteItem.tsx';
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
}

/** Recent entries with inline edit (value + backdate), delete, and the notes
 * that describe each entry shown right beneath it. */
export function EntryList({ tracker, entries, notesByEntry, onChanged }: EntryListProps) {
  if (entries.length === 0) {
    return <p className="muted">No entries yet. Log one above.</p>;
  }
  return (
    <ul className="entry-list">
      {entries
        .slice()
        .reverse()
        .map((entry) => (
          <EntryRow
            key={entry.id}
            tracker={tracker}
            entry={entry}
            notes={notesByEntry?.get(entry.id) ?? []}
            onChanged={onChanged}
          />
        ))}
    </ul>
  );
}

function EntryRow({
  tracker,
  entry,
  notes,
  onChanged,
}: {
  tracker: Tracker;
  entry: Entry;
  notes: Note[];
  onChanged: () => void;
}) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.value));
  const [when, setWhen] = useState(toDatetimeLocalValue(entry.occurred_at));
  const [busy, setBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteDraft.trim()) return;
    setBusy(true);
    try {
      await core.notes.create({
        tracker_id: tracker.id,
        entry_id: entry.id,
        body: noteDraft.trim(),
        occurred_at: entry.occurred_at,
      });
      setNoteDraft('');
      setAddingNote(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await core.entries.update(entry.id, {
        value: Number(value),
        occurred_at: fromDatetimeLocalValue(when),
      });
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
        <div className="entry__actions">
          <button className="btn btn--small" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--small btn--primary" onClick={save} disabled={busy}>
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="entry">
      <div className="entry__main">
        <span className="entry__value">{formatValue(tracker, entry.value)}</span>
        <span className="entry__time muted">{formatDateTime(entry.occurred_at)}</span>
        <div className="entry__actions">
          <button className="btn btn--small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="btn btn--small"
            onClick={() => setAddingNote((a) => !a)}
            aria-expanded={addingNote}
          >
            Note
          </button>
          <button className="btn btn--small btn--danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        </div>
      </div>

      {addingNote && (
        <form className="entry__add-note" onSubmit={addNote}>
          <textarea
            rows={2}
            placeholder="Note about this entry…"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn--small btn--primary"
            disabled={busy || !noteDraft.trim()}
          >
            Add
          </button>
        </form>
      )}

      {notes.length > 0 && (
        <ul className="entry__notes notes__list">
          {notes.map((note) => (
            <NoteItem key={note.id} note={note} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </li>
  );
}
