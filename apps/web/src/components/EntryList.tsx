import { useState } from 'react';
import type { Entry, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import {
  formatValue,
  formatDateTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';

interface EntryListProps {
  tracker: Tracker;
  entries: Entry[];
  onChanged: () => void;
}

/** Recent entries with inline edit (value + backdate) and delete. */
export function EntryList({ tracker, entries, onChanged }: EntryListProps) {
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
            onChanged={onChanged}
          />
        ))}
    </ul>
  );
}

function EntryRow({
  tracker,
  entry,
  onChanged,
}: {
  tracker: Tracker;
  entry: Entry;
  onChanged: () => void;
}) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.value));
  const [when, setWhen] = useState(toDatetimeLocalValue(entry.occurred_at));
  const [busy, setBusy] = useState(false);

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
      <span className="entry__value">{formatValue(tracker, entry.value)}</span>
      <span className="entry__time muted">{formatDateTime(entry.occurred_at)}</span>
      <div className="entry__actions">
        <button className="btn btn--small" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="btn btn--small btn--danger" onClick={remove} disabled={busy}>
          Delete
        </button>
      </div>
    </li>
  );
}
