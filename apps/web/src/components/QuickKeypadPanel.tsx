import { useState } from 'react';
import { formatNumber, formatValue, fromDatetimeLocalValue } from '../lib/format.ts';
import { topValues, type QuickPanelProps } from '../lib/quick.ts';
import { NumberKeypad } from './NumberKeypad.tsx';
import { QuickNoteField } from './QuickNoteField.tsx';
import { QuickWhenField } from './QuickWhenField.tsx';

/**
 * The keypad control, for trackers whose amount varies (money, durations,
 * choice codes). Preset chips carry the one-tap promise for the amounts you
 * actually use — the tracker's default plus the values its history shows are
 * most common — and the keypad handles everything else without the OS
 * keyboard sliding over the screen.
 */
export function QuickKeypadPanel({ tracker, entries, busy, onLog }: QuickPanelProps) {
  const [typed, setTyped] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');

  const occurredAt = when ? fromDatetimeLocalValue(when) : undefined;

  const presets = [
    tracker.default_value,
    ...topValues(entries, { limit: 3, exclude: [tracker.default_value] }),
  ];
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

      <div className="quick__secondary" role="group" aria-label="Quick amounts">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className="quick__chip quick__chip--accent"
            onClick={() => onLog(preset, note.trim() || undefined, occurredAt)}
            disabled={busy}
            aria-label={`Log ${formatValue(tracker, preset)}`}
          >
            {formatValue(tracker, preset)}
          </button>
        ))}
      </div>

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
