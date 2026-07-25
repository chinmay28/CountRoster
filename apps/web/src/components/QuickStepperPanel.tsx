import { useEffect, useRef, useState } from 'react';
import {
  formatNumber,
  formatRelativeTime,
  formatValue,
  fromDatetimeLocalValue,
} from '../lib/format.ts';
import { latestValue } from '../lib/range.ts';
import { applyStep, roundToStep, stepSize, type QuickPanelProps } from '../lib/quick.ts';
import { QuickWhenField } from './QuickWhenField.tsx';

/** Delay before a held +/− starts repeating, and the interval once it does. */
const HOLD_DELAY_MS = 450;
const HOLD_INTERVAL_MS = 90;

/** Circumference of the progress ring (r = 52 in its 120×120 viewBox). */
const RING = 2 * Math.PI * 52;

/**
 * The stepper control, for snapshot stats: weight, blood pressure, net worth.
 * A level is never entered from scratch — it's a nudge away from the last
 * reading — so the screen opens on that value, ± moves it by the tracker's
 * own default value (hold to repeat), and logging is an explicit confirm so a
 * pocket tap can't record a reading that never happened.
 */
export function QuickStepperPanel({ tracker, entries, busy, onLog }: QuickPanelProps) {
  const previous = entries.length > 0 ? latestValue(entries) : null;
  const step = stepSize(tracker);
  const [value, setValue] = useState(previous ?? tracker.default_value);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [when, setWhen] = useState('');
  const hold = useRef<{ timeout?: number; interval?: number }>({});

  // The last reading only arrives once the tracker's entries have loaded, and
  // the value shouldn't sit at a stale default when it does.
  const [seeded, setSeeded] = useState(previous != null);
  useEffect(() => {
    if (!seeded && previous != null) {
      setValue(previous);
      setSeeded(true);
    }
  }, [previous, seeded]);

  function stopHold() {
    window.clearTimeout(hold.current.timeout);
    window.clearInterval(hold.current.interval);
    hold.current = {};
  }
  useEffect(() => stopHold, []);

  function nudge(direction: 1 | -1) {
    setValue((current) => applyStep(current, step, direction));
  }

  /** Tap steps once; holding repeats until the finger lifts. */
  function startHold(direction: 1 | -1) {
    nudge(direction);
    stopHold();
    hold.current.timeout = window.setTimeout(() => {
      hold.current.interval = window.setInterval(() => nudge(direction), HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  }

  function commitDraft() {
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed)) setValue(parsed);
    setTyping(false);
  }

  const progress =
    tracker.target != null && tracker.target !== 0
      ? Math.max(0, Math.min(1, value / tracker.target))
      : null;
  const recent = [...entries].reverse().slice(0, 3);
  const delta = previous == null ? null : roundToStep(value - previous, step);
  // Under the dial: how long ago the last reading was taken while the value
  // still *is* that reading (repeating the number would say nothing), and the
  // move away from it once the stepper has been touched.
  const subtitle =
    previous == null
      ? 'first reading'
      : delta == null || delta === 0
        ? formatRelativeTime(entries[entries.length - 1]!.occurred_at)
        : `last ${formatNumber(previous, tracker.unit)} · ${
            delta > 0 ? '+' : '−'
          }${formatNumber(Math.abs(delta))}`;

  return (
    <div className="quick__control quick__control--stepper">
      <div className="quick-stepper__dial">
        {progress != null && (
          <svg className="quick-stepper__ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle className="quick-stepper__ring-track" cx="60" cy="60" r="52" />
            <circle
              className="quick-stepper__ring-fill"
              cx="60"
              cy="60"
              r="52"
              stroke={tracker.color}
              strokeDasharray={RING}
              strokeDashoffset={RING * (1 - progress)}
            />
          </svg>
        )}
        <div className="quick-stepper__center">
          {typing ? (
            <input
              className="quick-stepper__input"
              type="number"
              step="any"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDraft();
                }
              }}
              aria-label="Reading"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="quick-stepper__value"
              style={{ color: tracker.color }}
              onClick={() => {
                setDraft(String(value));
                setTyping(true);
              }}
              aria-label={`Reading ${formatValue(tracker, value)}. Tap to type a value`}
            >
              {formatNumber(value, tracker.unit)}
            </button>
          )}
          <span className="quick-stepper__previous">{subtitle}</span>
        </div>
      </div>

      <QuickWhenField value={when} onChange={setWhen} />

      <div className="quick-stepper__controls">
        <button
          type="button"
          className="quick-stepper__step"
          onPointerDown={() => startHold(-1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label={`Decrease by ${formatNumber(step)}`}
        >
          −
        </button>
        <button
          type="button"
          className="quick__commit quick-stepper__commit"
          onClick={() => onLog(value, undefined, when ? fromDatetimeLocalValue(when) : undefined)}
          disabled={busy}
        >
          Log reading
        </button>
        <button
          type="button"
          className="quick-stepper__step"
          onPointerDown={() => startHold(1)}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          aria-label={`Increase by ${formatNumber(step)}`}
        >
          +
        </button>
      </div>

      {recent.length > 0 && (
        <ul className="quick-stepper__history">
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
