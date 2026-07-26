import { useState } from 'react';
import type { Entry, Note, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '../lib/format.ts';

/**
 * Editing one entry from the current-window table: its value, when it
 * happened, and the single note that describes it. Kept out of the row
 * component so the table stays about layout, and the rules — an emptied note
 * deletes itself, a new one is created linked to the entry — read in one
 * place. The timeline's own editor (`EntryList`) additionally edits custom
 * field answers, which this window view doesn't offer.
 */
export function useEntryEditor(
  tracker: Tracker,
  entry: Entry,
  note: Note | null,
  onChanged: () => void,
) {
  const core = useCore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.value));
  const [when, setWhen] = useState(toDatetimeLocalValue(entry.occurred_at));
  const [noteBody, setNoteBody] = useState(note?.body ?? '');
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  function start() {
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

  return {
    editing,
    busy,
    value,
    setValue,
    when,
    setWhen,
    noteBody,
    setNoteBody,
    showHistory,
    setShowHistory,
    start,
    cancel: () => setEditing(false),
    save,
    remove,
  };
}
