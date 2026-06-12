import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import {
  dateInputLabel,
  fromDatetimeLocalValue,
  shiftDateInputValue,
  toDateInputValue,
} from '../lib/format.ts';

/** One value field on the sheet. Extra rows are duplicates of a tracker. */
interface Row {
  key: string;
  trackerId: string;
  extra: boolean;
}

/**
 * Multi-log: pin a date once, then rapid-fire values down the roster and
 * submit them as one atomic batch. Built for thumbs: every field raises the
 * numeric keypad, and the keypad's own action key ("next") hops to the next
 * tracker so the keyboard never has to close between entries. Blank rows are
 * simply skipped; "+" duplicates a row to log the same tracker twice.
 */
export function MultiLogPage() {
  const core = useCore();
  const { data: trackers, loading, error } = useAsync(
    () => core.trackers.list(),
    [],
  );
  // Derived trackers compute their value from sources — nothing to type.
  const loggable = useMemo(
    () => (trackers ?? []).filter((t) => t.is_derived !== 1),
    [trackers],
  );

  const today = toDateInputValue();
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<Row[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const dupSeq = useRef(0);

  useEffect(() => {
    setRows(loggable.map((t) => ({ key: t.id, trackerId: t.id, extra: false })));
  }, [loggable]);

  const byId = useMemo(
    () => new Map(loggable.map((t) => [t.id, t])),
    [loggable],
  );
  const filledCount = rows.filter((r) => (values[r.key] ?? '').trim() !== '').length;

  function setValue(key: string, raw: string) {
    setValues((v) => ({ ...v, [key]: raw }));
    setStatus(null);
  }

  function focusRow(row: Row | undefined) {
    if (!row) return;
    const el = inputs.current.get(row.key);
    if (!el) return;
    el.focus();
    el.select();
    // Keep the freshly focused row clear of the on-screen keyboard.
    el.scrollIntoView?.({ block: 'center' });
  }

  /** The keypad's action key: commit this field and hop to the next row. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>, idx: number) {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // never let Enter submit the form mid-sheet
    if (idx < rows.length - 1) focusRow(rows[idx + 1]);
    else e.currentTarget.blur(); // last row: close the keyboard, reveal the bar
  }

  /** "+": another entry for the same tracker, inserted right below its row. */
  function duplicateRow(idx: number) {
    const row = rows[idx];
    if (!row) return;
    const key = `${row.trackerId}#${dupSeq.current++}`;
    setRows((rs) => [
      ...rs.slice(0, idx + 1),
      { key, trackerId: row.trackerId, extra: true },
      ...rs.slice(idx + 1),
    ]);
    requestAnimationFrame(() => {
      const el = inputs.current.get(key);
      el?.focus();
      el?.scrollIntoView?.({ block: 'center' });
    });
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setValues((v) => {
      const next = { ...v };
      delete next[key];
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const filled = rows
      .map((r) => ({ trackerId: r.trackerId, raw: (values[r.key] ?? '').trim() }))
      .filter((x) => x.raw !== '' && Number.isFinite(Number(x.raw)));
    if (filled.length === 0 || busy) return;

    setBusy(true);
    setSubmitError(null);
    try {
      // Today's entries are stamped "now" by the server, like quick-log; a
      // backdated day gets noon so it lands mid-day regardless of day-start.
      const occurredAt =
        date === today ? undefined : fromDatetimeLocalValue(`${date}T12:00`);
      const logged = await core.entries.logMany(
        filled.map(({ trackerId, raw }) => ({
          tracker_id: trackerId,
          value: Number(raw),
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
        })),
      );
      setStatus(
        `Logged ${logged.length} ${logged.length === 1 ? 'entry' : 'entries'} · ${dateInputLabel(date)}`,
      );
      setValues({});
      setRows((rs) => rs.filter((r) => !r.extra));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading trackers…</p>;
  if (error) return <p className="error">Failed to load: {error.message}</p>;

  if (loggable.length === 0) {
    return (
      <div className="empty">
        <h1>Nothing to log yet</h1>
        <p>Create a tracker first, then log a whole day here in one go.</p>
        <Link to="/trackers/new" className="btn btn--primary">
          New tracker
        </Link>
      </div>
    );
  }

  return (
    <section className="multilog">
      <h1 className="page-title">Multi-log</h1>

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
          className={`multilog__chip${
            date === shiftDateInputValue(today, -1) ? ' multilog__chip--active' : ''
          }`}
          onClick={() => setDate(shiftDateInputValue(today, -1))}
        >
          Yesterday
        </button>
      </div>

      <form onSubmit={submit}>
        <ul className="multilog__rows">
          {rows.map((row, idx) => {
            const tracker = byId.get(row.trackerId);
            if (!tracker) return null;
            return (
              <MultiLogRow
                key={row.key}
                row={row}
                tracker={tracker}
                value={values[row.key] ?? ''}
                last={idx === rows.length - 1}
                inputRef={(el) => {
                  if (el) inputs.current.set(row.key, el);
                  else inputs.current.delete(row.key);
                }}
                onChange={(raw) => setValue(row.key, raw)}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onDuplicate={() => duplicateRow(idx)}
                onRemove={() => removeRow(row.key)}
              />
            );
          })}
        </ul>

        {/* Sticky so the action survives scrolling a long roster. */}
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
            disabled={busy || filledCount === 0}
          >
            {filledCount === 0
              ? 'Enter values to log'
              : `Log ${filledCount} ${filledCount === 1 ? 'entry' : 'entries'} · ${dateInputLabel(date)}`}
          </button>
        </div>
      </form>
    </section>
  );
}

interface MultiLogRowProps {
  row: Row;
  tracker: Tracker;
  value: string;
  last: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onChange: (raw: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function MultiLogRow({
  row,
  tracker,
  value,
  last,
  inputRef,
  onChange,
  onKeyDown,
  onDuplicate,
  onRemove,
}: MultiLogRowProps) {
  return (
    <li className={`multilog__row${row.extra ? ' multilog__row--extra' : ''}`}>
      <span
        className="multilog__swatch"
        style={{ background: tracker.color }}
        aria-hidden="true"
      />
      <label className="multilog__name" htmlFor={`mlog-${row.key}`}>
        <span className="multilog__name-text">{tracker.name}</span>
        {tracker.unit && <span className="multilog__unit">{tracker.unit}</span>}
      </label>
      <input
        id={`mlog-${row.key}`}
        ref={inputRef}
        className="multilog__input"
        type="number"
        step="any"
        inputMode="decimal"
        enterKeyHint={last ? 'done' : 'next'}
        placeholder="–"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
      />
      {row.extra ? (
        <button
          type="button"
          className="multilog__row-btn"
          onClick={onRemove}
          aria-label={`Remove extra ${tracker.name} entry`}
          title="Remove this entry"
        >
          ×
        </button>
      ) : (
        <button
          type="button"
          className="multilog__row-btn"
          onClick={onDuplicate}
          aria-label={`Add another ${tracker.name} entry`}
          title="Add another entry for this tracker"
        >
          +
        </button>
      )}
    </li>
  );
}
