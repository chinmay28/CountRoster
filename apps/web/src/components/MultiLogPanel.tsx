import { useRef, useState } from 'react';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { readableInk } from '../lib/color.ts';
import {
  dateInputLabel,
  fromDatetimeLocalValue,
  shiftDateInputValue,
  toDateInputValue,
} from '../lib/format.ts';

interface MultiLogPanelProps {
  tracker: Tracker;
  /** Called after a successful batch so the parent can refresh. */
  onLogged: () => void;
}

/**
 * "Log multiple" for one tracker: pin a date once, then rapid-fire entry
 * values and submit them as a single atomic batch. Built for thumbs: every
 * field raises the numeric keypad, and the keypad's action key ("next") moves
 * to the next row — on the last filled row it *creates* the next one — so the
 * keyboard never has to close between entries. Blank rows are skipped.
 */
export function MultiLogPanel({ tracker, onLogged }: MultiLogPanelProps) {
  const core = useCore();
  const today = toDateInputValue();
  const [date, setDate] = useState(today);
  const seq = useRef(1);
  const [rows, setRows] = useState<string[]>(['row-0']);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const filledCount = rows.filter((k) => (values[k] ?? '').trim() !== '').length;

  function setValue(key: string, raw: string) {
    setValues((v) => ({ ...v, [key]: raw }));
    setStatus(null);
  }

  function focusKey(key: string | undefined) {
    if (!key) return;
    const el = inputs.current.get(key);
    if (!el) return;
    el.focus();
    el.select();
    // Keep the freshly focused row clear of the on-screen keyboard.
    el.scrollIntoView?.({ block: 'center' });
  }

  function addRow() {
    const key = `row-${seq.current++}`;
    setRows((rs) => [...rs, key]);
    requestAnimationFrame(() => focusKey(key));
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((k) => k !== key));
    setValues((v) => {
      const next = { ...v };
      delete next[key];
      return next;
    });
  }

  /**
   * The keypad's action key: hop to the next row, growing the sheet when the
   * last row already holds a value. Enter on a blank last row just closes the
   * keyboard — the natural "I'm done" gesture.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>, idx: number) {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // never let Enter submit the form mid-sheet
    if (idx < rows.length - 1) focusKey(rows[idx + 1]);
    else if (e.currentTarget.value.trim() !== '') addRow();
    else e.currentTarget.blur();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const filled = rows
      .map((k) => (values[k] ?? '').trim())
      .filter((raw) => raw !== '' && Number.isFinite(Number(raw)));
    if (filled.length === 0 || busy) return;

    setBusy(true);
    setSubmitError(null);
    try {
      // Today's entries are stamped "now" by the server, like the single-entry
      // form; a backdated day gets noon so it lands mid-day regardless of
      // day-start.
      const occurredAt =
        date === today ? undefined : fromDatetimeLocalValue(`${date}T12:00`);
      const logged = await core.entries.logMany(
        filled.map((raw) => ({
          tracker_id: tracker.id,
          value: Number(raw),
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
        })),
      );
      setStatus(
        `Logged ${logged.length} ${logged.length === 1 ? 'entry' : 'entries'} · ${dateInputLabel(date)}`,
      );
      setRows([`row-${seq.current++}`]);
      setValues({});
      onLogged();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const yesterday = shiftDateInputValue(today, -1);

  return (
    <div className="multilog">
      {/* Pin the day once; every value below logs to it. */}
      <div className="card multilog__datebar">
        <button
          type="button"
          className="btn multilog__step"
          onClick={() => setDate((d) => shiftDateInputValue(d, -1))}
          aria-label="Previous day"
        >
          ‹
        </button>
        <div className="multilog__date">
          <span className="multilog__date-label">{dateInputLabel(date)}</span>
          <input
            type="date"
            value={date}
            max={today}
            aria-label="Date to log entries for"
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn multilog__step"
          onClick={() => setDate((d) => shiftDateInputValue(d, 1))}
          disabled={date >= today}
          aria-label="Next day"
        >
          ›
        </button>
      </div>
      <div className="multilog__chips">
        <button
          type="button"
          className={`multilog__chip${date === today ? ' multilog__chip--active' : ''}`}
          onClick={() => setDate(today)}
        >
          Today
        </button>
        <button
          type="button"
          className={`multilog__chip${date === yesterday ? ' multilog__chip--active' : ''}`}
          onClick={() => setDate(yesterday)}
        >
          Yesterday
        </button>
      </div>

      <form onSubmit={submit}>
        <ul className="multilog__rows">
          {rows.map((key, idx) => (
            <li key={key} className="multilog__row">
              <span
                className="multilog__swatch"
                style={{ background: tracker.color }}
                aria-hidden="true"
              />
              <label className="multilog__name" htmlFor={`mlog-${key}`}>
                <span className="multilog__name-text">Entry {idx + 1}</span>
                {tracker.unit && (
                  <span className="multilog__unit">{tracker.unit}</span>
                )}
              </label>
              <input
                id={`mlog-${key}`}
                ref={(el) => {
                  if (el) inputs.current.set(key, el);
                  else inputs.current.delete(key);
                }}
                className="multilog__input"
                type="number"
                step="any"
                inputMode="decimal"
                enterKeyHint="next"
                placeholder="–"
                value={values[key] ?? ''}
                onChange={(e) => setValue(key, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onFocus={(e) => e.currentTarget.select()}
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  className="multilog__row-btn"
                  onClick={() => removeRow(key)}
                  aria-label={`Remove entry ${idx + 1}`}
                  title="Remove this row"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="btn btn--small multilog__add"
          onClick={addRow}
        >
          + Add a row
        </button>

        <div className="multilog__submitbar">
          {status && (
            <span className="multilog__status" role="status">
              {status}
            </span>
          )}
          {submitError && <span className="error">{submitError}</span>}
          <button
            type="submit"
            className="btn btn--primary"
            style={{ background: tracker.color, color: readableInk(tracker.color) }}
            disabled={busy || filledCount === 0}
          >
            {filledCount === 0
              ? 'Enter values to log'
              : `Log ${filledCount} ${filledCount === 1 ? 'entry' : 'entries'} · ${dateInputLabel(date)}`}
          </button>
        </div>
      </form>
    </div>
  );
}
