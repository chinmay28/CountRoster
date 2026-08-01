import { useState } from 'react';
import {
  formatNumber,
  formatRelativeTime,
  formatValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';
import { readingDelta, type QuickPanelProps } from '../lib/quick.ts';
import { NumberKeypad } from './NumberKeypad.tsx';
import { QuickNoteField } from './QuickNoteField.tsx';
import { QuickWhenField } from './QuickWhenField.tsx';

/**
 * The keypad control, for every value that gets typed: amounts that vary
 * (money, durations, choice codes) and snapshot readings (weight, blood
 * pressure, net worth). The number is always typed, on a keypad that never
 * shifts under a thumb the way the OS keyboard does when it slides over the
 * screen.
 *
 * A snapshot starts blank like anything else — seeding it with the previous
 * reading only invites logging that stale number by accident, and a scale
 * gives you the whole figure anyway. The reading before it stays on screen as
 * context (last value, and the move away from it once you've typed), which is
 * what you actually want while entering one.
 */
export function QuickKeypadPanel({ tracker, entries, busy, onLog }: QuickPanelProps) {
  const [typed, setTyped] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');

  const occurredAt = when ? fromDatetimeLocalValue(when) : undefined;

  const amount = typed === '' ? null : Number(typed);
  const valid = amount != null && Number.isFinite(amount);

  const snapshot = tracker.is_snapshot === 1;
  const last = snapshot && entries.length > 0 ? entries[entries.length - 1]! : null;
  const delta = last && valid ? readingDelta(amount, last.value) : null;
  const recent = snapshot ? [...entries].reverse().slice(0, 3) : [];

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
        {/* Where the reading being typed stands against the one before it.
            It only says anything once something is typed — until then the
            headline above already shows the current level, and the readings
            below show when each was taken — but the line is always here, so
            the first digit can't shove the keypad down under the thumb
            reaching for it. */}
        {last && (
          <span className="quick-keypad__preview" aria-hidden={delta == null}>
            {delta == null
              ? '\u00a0' /* keeps the line's height while it has nothing to say */
              : `last ${formatNumber(last.value, tracker.unit)} · ${
                  delta > 0 ? '+' : delta < 0 ? '−' : '±'
                }${formatNumber(Math.abs(delta))}`}
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
          {snapshot ? 'Log reading' : 'Log entry'}
        </button>
      </div>

      {recent.length > 0 && (
        <ul className="quick-keypad__history">
          {recent.map((entry) => (
            <li key={entry.id}>
              <span>{formatValue(tracker, entry.value)}</span>
              <span className="quick__muted">{formatRelativeTime(entry.occurred_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
