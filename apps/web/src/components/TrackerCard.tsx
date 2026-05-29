import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { formatValue } from '../lib/format.ts';

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
 */
export function TrackerCard({ tracker, todayTotal, onLogged }: TrackerCardProps) {
  const core = useCore();
  const [busy, setBusy] = useState(false);

  async function quickLog() {
    setBusy(true);
    try {
      await core.entries.log(tracker.id);
      onLogged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card tracker-card" style={{ borderTopColor: tracker.color }}>
      <Link to={`/trackers/${tracker.id}`} className="tracker-card__body">
        <span className="tracker-card__name">{tracker.name}</span>
        <span className="tracker-card__total">
          {formatValue(tracker, todayTotal)}
        </span>
        <span className="tracker-card__sub">today</span>
      </Link>
      <button
        type="button"
        className="btn btn--log"
        onClick={quickLog}
        disabled={busy}
        aria-label={`Log ${tracker.name}`}
      >
        +{tracker.default_value}
      </button>
    </div>
  );
}
