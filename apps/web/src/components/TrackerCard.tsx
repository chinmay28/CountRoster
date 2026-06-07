import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { formatValue } from '../lib/format.ts';
import { RESET_PERIOD_LABEL } from '../lib/range.ts';
import { readableInk } from '../lib/color.ts';

interface TrackerCardProps {
  tracker: Tracker;
  /** Sum of today's entry values for this tracker. */
  todayTotal: number;
  /** Called after a successful quick-log so the parent can refresh. */
  onLogged: () => void;
}

/**
 * Home-screen card: shows today's total and a one-tap log button that
 * increments by the tracker's default value (DESIGN §3.2 "Tap to log").
 * Tapping the chevron opens a small panel to log a *custom* value and,
 * optionally, attach a note to that very entry.
 */
export function TrackerCard({ tracker, todayTotal, onLogged }: TrackerCardProps) {
  const core = useCore();
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  // Tint the count button with the tracker's own color (readable ink on top).
  const accent = { background: tracker.color, color: readableInk(tracker.color) };

  async function quickLog() {
    setBusy(true);
    try {
      await core.entries.log(tracker.id);
      onLogged();
    } finally {
      setBusy(false);
    }
  }

  async function customLog(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const entry = await core.entries.log(tracker.id, {
        ...(value.trim() ? { value: Number(value) } : {}),
      });
      if (note.trim()) {
        await core.notes.create({
          tracker_id: tracker.id,
          entry_id: entry.id,
          body: note.trim(),
        });
      }
      setValue('');
      setNote('');
      setCustomOpen(false);
      onLogged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card tracker-card" style={{ borderTopColor: tracker.color }}>
      <div className="tracker-card__top">
        <Link to={`/trackers/${tracker.id}`} className="tracker-card__body">
          <span className="tracker-card__name">{tracker.name}</span>
          <span className="tracker-card__total" style={{ color: tracker.color }}>
            {formatValue(tracker, todayTotal)}
          </span>
          <span className="tracker-card__sub">{RESET_PERIOD_LABEL[tracker.reset_period]}</span>
        </Link>
        <div className="tracker-card__actions">
          <button
            type="button"
            className="btn btn--log"
            style={accent}
            onClick={quickLog}
            disabled={busy}
            aria-label={`Log ${tracker.name}`}
          >
            +{tracker.default_value}
          </button>
          <button
            type="button"
            className="btn btn--small tracker-card__custom-toggle"
            onClick={() => setCustomOpen((o) => !o)}
            aria-expanded={customOpen}
            aria-label={`Log a custom value for ${tracker.name}`}
            title="Custom value"
          >
            {customOpen ? '×' : '⋯'}
          </button>
        </div>
      </div>

      {customOpen && (
        <form className="tracker-card__custom" onSubmit={customLog}>
          <input
            type="number"
            step="any"
            inputMode="decimal"
            placeholder={`Value (default ${tracker.default_value})`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <textarea
            rows={2}
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
            Log
          </button>
        </form>
      )}
    </div>
  );
}
