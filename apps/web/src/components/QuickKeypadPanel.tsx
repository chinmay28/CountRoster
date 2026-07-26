import { useState } from 'react';
import { formatNumber, formatValue, fromDatetimeLocalValue } from '../lib/format.ts';
import { type QuickPanelProps } from '../lib/quick.ts';
import { NumberKeypad } from './NumberKeypad.tsx';
import { QuickNoteField } from './QuickNoteField.tsx';
import { QuickWhenField } from './QuickWhenField.tsx';

/**
 * The keypad control, for trackers whose amount varies (money, durations,
 * choice codes). The amount is always typed, on a keypad that never shifts
 * under a thumb the way the OS keyboard does when it slides over the screen.
 */
export function QuickKeypadPanel({ tracker, busy, onLog }: QuickPanelProps) {
  const [typed, setTyped] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');

  const occurredAt = when ? fromDatetimeLocalValue(when) : undefined;

  const amount = typed === '' ? null : Number(typed);
  const valid = amount != null && Number.isFinite(amount);

  function submit() {
    if (!valid) return;
    onLog(amount, note.trim() || undefined, occurredAt);
    setTyped('');
    setNote('');
    setNoteOpen(false);
  }

  return (
    <div className="quick__control quick__control--keypad">
      <div className="quick-keypad__display">
        <span
          className={`quick-keypad__amount${valid ? '' : ' quick-keypad__amount--empty'}`}
          style={{ color: tracker.color }}
        >
          {formatNumber(amount ?? 0, tracker.unit)}
        </span>
        {/* Durations are stored in seconds; show what the number means. */}
        {tracker.kind === 'duration' && (
          <span className="quick-keypad__preview">
            {formatValue(tracker, amount ?? 0)}
          </span>
        )}
      </div>

      <QuickWhenField value={when} onChange={setWhen} />

      <NumberKeypad value={typed} onChange={setTyped} />

      {noteOpen && <QuickNoteField value={note} onChange={setNote} autoFocus />}

      <div className="quick-keypad__actions">
        <button
          type="button"
          className="quick__chip"
          onClick={() => setNoteOpen((open) => !open)}
          aria-expanded={noteOpen}
        >
          {noteOpen ? 'Hide note' : 'Note'}
        </button>
        <button
          type="button"
          className="quick__commit"
          onClick={submit}
          disabled={busy || !valid}
        >
          Log entry
        </button>
      </div>
    </div>
  );
}
