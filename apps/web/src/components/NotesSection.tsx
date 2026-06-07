import { useState } from 'react';
import type { Note } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { NoteItem } from './NoteItem.tsx';
import { fromDatetimeLocalValue } from '../lib/format.ts';

interface NotesSectionProps {
  trackerId: string;
  /** Standalone notes (not tied to a specific entry). */
  notes: Note[];
  /** Called after add/edit/delete so the parent can refetch. */
  onChanged: () => void;
}

/**
 * Standalone journal notes for a tracker, with add / edit / delete and edit
 * history. Notes attached to a specific entry are shown inline with that entry
 * (see EntryList) — this section holds the general, entry-less ones.
 */
export function NotesSection({ trackerId, notes, onChanged }: NotesSectionProps) {
  const core = useCore();
  const [draft, setDraft] = useState('');
  const [when, setWhen] = useState('');
  const [adding, setAdding] = useState(false);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setAdding(true);
    try {
      await core.notes.create({
        tracker_id: trackerId,
        body: draft.trim(),
        ...(when ? { occurred_at: fromDatetimeLocalValue(when) } : {}),
      });
      setDraft('');
      setWhen('');
      onChanged();
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
        <div className="notes__add-row">
          <label className="field">
            <span>When (optional)</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={adding || !draft.trim()}
          >
            Add note
          </button>
        </div>
      </form>

      {notes.length === 0 && <p className="muted">No notes yet.</p>}

      <ul className="notes__list">
        {notes
          .slice()
          .reverse()
          .map((note) => (
            <NoteItem key={note.id} note={note} onChanged={onChanged} />
          ))}
      </ul>
    </section>
  );
}
