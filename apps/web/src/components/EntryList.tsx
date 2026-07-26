import { useMemo, useState } from 'react';
import type { Entry, Note, Tracker, TrackerField } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { NoteHistory } from './NoteItem.tsx';
import { EntryFieldsInput } from './EntryFieldsInput.tsx';
import {
  formatValue,
  formatDateTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';
import { answersFromEntry, entryChips, type FieldAnswers } from '../lib/fields.ts';

interface EntryListProps {
  tracker: Tracker;
  entries: Entry[];
  /** The tracker's custom fields, so each entry can show and edit its answers. */
  fields?: readonly TrackerField[];
  /** Notes linked to an entry, keyed by `entry_id`. */
  notesByEntry?: Map<string, Note[]>;
  onChanged: () => void;
  /**
   * Render entries without edit/delete controls. Used for derived trackers,
   * whose entries are virtual (computed from their sources) and not editable.
   */
  readOnly?: boolean;
}

/** How many entries are shown per page. */
const PAGE_SIZE = 10;

/** Recent entries with a single inline edit (value, backdate, and the one note
 * describing the entry) and delete. The entry's note is shown right beneath it.
 * The list is paginated (newest first) and searchable by the note attached to
 * an entry. */
export function EntryList({
  tracker,
  entries,
  fields = [],
  notesByEntry,
  onChanged,
  readOnly = false,
}: EntryListProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // Newest first, then narrowed to entries whose linked note — or whose
  // custom-field answers — match the search, so "bottle" finds the feeds
  // logged that way even when nothing was written about them.
  const filtered = useMemo(() => {
    const newestFirst = entries.slice().reverse();
    const q = query.trim().toLowerCase();
    if (!q) return newestFirst;
    return newestFirst.filter(
      (entry) =>
        (notesByEntry?.get(entry.id) ?? []).some((n) =>
          n.body.toLowerCase().includes(q),
        ) ||
        entryChips(entry, fields).some((chip) => chip.label.toLowerCase().includes(q)),
    );
  }, [entries, fields, notesByEntry, query]);

  // Deleting the last entry of a trailing page (or narrowing the search) can
  // leave `page` past the end — clamp rather than showing an empty page.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  if (entries.length === 0) {
    return <p className="muted">No entries yet.</p>;
  }

  return (
    <div className="entry-browser">
      <input
        type="search"
        className="entry-browser__search"
        placeholder={
          fields.length > 0 ? 'Search entries by note or detail…' : 'Search entries by note…'
        }
        aria-label="Search entries by note"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPage(0);
        }}
      />

      {filtered.length === 0 ? (
        <p className="muted">No entries match “{query.trim()}”.</p>
      ) : (
        <ul className="entry-list">
          {visible.map((entry, i) => (
            <EntryRow
              key={readOnly ? `${entry.id}-${current * PAGE_SIZE + i}` : entry.id}
              tracker={tracker}
              entry={entry}
              fields={fields}
              note={notesByEntry?.get(entry.id)?.[0] ?? null}
              onChanged={onChanged}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="entry-browser__pager" aria-label="Entry pages">
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
          >
            Newer
          </button>
          <span className="muted">
            Page {current + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setPage(current + 1)}
            disabled={current >= pageCount - 1}
          >
            Older
          </button>
        </nav>
      )}
    </div>
  );
}

function EntryRow({
  tracker,
  entry,
  fields,
  note,
  onChanged,
  readOnly,
}: {
  tracker: Tracker;
  entry: Entry;
  fields: readonly TrackerField[];
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
  const [answers, setAnswers] = useState<FieldAnswers>({});
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chips = entryChips(entry, fields);

  function startEditing() {
    setValue(String(entry.value));
    setWhen(toDatetimeLocalValue(entry.occurred_at));
    setNoteBody(note?.body ?? '');
    setAnswers(answersFromEntry(entry, fields));
    setError(null);
    setShowHistory(false);
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const occurredAt = fromDatetimeLocalValue(when);
      await core.entries.update(entry.id, {
        value: Number(value),
        occurred_at: occurredAt,
        // Every field the form showed is sent, so clearing one sticks.
        ...(fields.length > 0 ? { fields: answers } : {}),
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </div>
        {fields.length > 0 && (
          <EntryFieldsInput
            fields={fields}
            answers={answers}
            onChange={setAnswers}
            disabled={busy}
            accent={tracker.color}
          />
        )}
        <textarea
          className="entry__note-input"
          rows={2}
          placeholder="Note (optional)…"
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
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

      {chips.length > 0 && (
        <ul className="entry__chips">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className="chip"
              style={
                chip.color
                  ? {
                      borderColor: chip.color,
                      background: `color-mix(in srgb, ${chip.color} 18%, transparent)`,
                    }
                  : undefined
              }
            >
              {chip.label}
            </li>
          ))}
        </ul>
      )}

      {note && <p className="entry__note">{note.body}</p>}
    </li>
  );
}
