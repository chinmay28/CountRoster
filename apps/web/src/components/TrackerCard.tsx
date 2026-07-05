import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { formatValue, fromDatetimeLocalValue } from '../lib/format.ts';
import { RESET_PERIOD_LABEL } from '../lib/range.ts';
import { readableInk } from '../lib/color.ts';

interface TrackerCardProps {
  tracker: Tracker;
  /**
   * The card's headline number: the reset-window total, or the latest
   * reading for a snapshot tracker.
   */
  todayTotal: number;
  /** Called after a successful quick-log so the parent can refresh. */
  onLogged: () => void;
}

/**
 * Home-screen card: shows the tracker's running total and a single log button.
 * Tapping it opens a compact panel to enter a value (blank falls back to the
 * tracker's default) and, optionally, a note attached to that very entry.
 */
export function TrackerCard({ tracker, todayTotal, onLogged }: TrackerCardProps) {
  const core = useCore();
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [value, setValue] = useState('');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');

  // Tint the log button with the tracker's own color (readable ink on top).
  const accent = { background: tracker.color, color: readableInk(tracker.color) };

  async function customLog(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const occurredAt = when ? fromDatetimeLocalValue(when) : undefined;
      const entry = await core.entries.log(tracker.id, {
        ...(value.trim() ? { value: Number(value) } : {}),
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
      });
      if (note.trim()) {
        await core.notes.create({
          tracker_id: tracker.id,
          entry_id: entry.id,
          body: note.trim(),
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
        });
      }
      setValue('');
      setWhen('');
      setNote('');
      setCustomOpen(false);
      onLogged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`card tracker-card${customOpen ? ' tracker-card--logging' : ''}`}
      style={{ borderTopColor: tracker.color }}
    >
      <div className="tracker-card__top">
        <Link to={`/trackers/${tracker.id}`} className="tracker-card__body">
          <span className="tracker-card__name">{tracker.name}</span>
          <span className="tracker-card__total" style={{ color: tracker.color }}>
            {formatValue(tracker, todayTotal)}
          </span>
          <span className="tracker-card__sub">
            {tracker.is_snapshot === 1
              ? 'current'
              : RESET_PERIOD_LABEL[tracker.reset_period]}
            {tracker.is_hidden === 1 ? ' · hidden' : ''}
          </span>
        </Link>
        <div className="tracker-card__actions">
          <button
            type="button"
            className="btn btn--log tracker-card__log-toggle"
            style={accent}
            onClick={() => setCustomOpen((o) => !o)}
            aria-expanded={customOpen}
            aria-label={`Log ${tracker.name}`}
            title="Log an entry"
          >
            {customOpen ? '×' : '+'}
          </button>
        </div>
      </div>

      {customOpen && (
        <form className="tracker-card__custom" onSubmit={customLog}>
          <label className="field tracker-card__field-value">
            <span>Value</span>
            <input
              type="number"
              step="any"
              inputMode="decimal"
              placeholder={`Default ${tracker.default_value}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field tracker-card__field-when">
            <span>When (optional)</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <label className="field tracker-card__field-note">
            <span>Note (optional)</span>
            <textarea
              rows={2}
              placeholder="Describe this entry…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--primary btn--small" disabled={busy}>
            Log
          </button>
        </form>
      )}
    </div>
  );
}
