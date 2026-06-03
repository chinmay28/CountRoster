import { useState } from 'react';
import type { Tracker, BucketPeriod } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue } from '../lib/format.ts';
import { lastNBuckets } from '../lib/range.ts';

/** How many buckets to show per period, and the toggle label. */
const PERIODS: { period: BucketPeriod; label: string; count: number }[] = [
  { period: 'day', label: 'Day', count: 14 },
  { period: 'week', label: 'Week', count: 8 },
  { period: 'month', label: 'Month', count: 6 },
  { period: 'year', label: 'Year', count: 5 },
];

interface StatsPanelProps {
  tracker: Tracker;
  /** Bump to re-fetch after a log/edit elsewhere on the page. */
  refreshKey: number;
}

/** Charts & stats for a tracker: streak, target progress, and a bucket chart. */
export function StatsPanel({ tracker, refreshKey }: StatsPanelProps) {
  const core = useCore();
  const [period, setPeriod] = useState<BucketPeriod>('day');
  const count = PERIODS.find((p) => p.period === period)!.count;

  const { data, loading, error } = useAsync(async () => {
    const range = lastNBuckets(period, count, tracker.week_start);
    const [buckets, streak, target] = await Promise.all([
      core.stats.bucket(tracker.id, range, period),
      core.stats.streak(tracker.id),
      core.stats.targetProgress(tracker.id),
    ]);
    return { buckets, streak, target };
  }, [tracker.id, period, count, refreshKey]);

  return (
    <section className="stats">
      <div className="stats__head">
        <h2>Trends</h2>
        <div className="stats__periods" role="group" aria-label="Chart period">
          {PERIODS.map((p) => (
            <button
              key={p.period}
              type="button"
              className={`btn btn--small${p.period === period ? ' btn--active' : ''}`}
              aria-pressed={p.period === period}
              onClick={() => setPeriod(p.period)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error.message}</p>}
      {loading && !data && <p className="muted">Loading stats…</p>}

      {data && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-card__value">🔥 {data.streak.current}</span>
              <span className="stat-card__label">
                day streak · best {data.streak.longest}
              </span>
            </div>
            {data.target.target != null && (
              <div className="stat-card">
                <span className="stat-card__value">
                  {formatValue(tracker, data.target.current)}
                  <span className="muted">
                    {' / '}
                    {formatValue(tracker, data.target.target)}
                  </span>
                </span>
                <span className="stat-card__label">
                  this period · {Math.round((data.target.ratio ?? 0) * 100)}%
                </span>
                <div className="progress" aria-hidden="true">
                  <div
                    className="progress__fill"
                    style={{
                      width: `${(data.target.ratio ?? 0) * 100}%`,
                      background: tracker.color,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <BucketChart
            tracker={tracker}
            buckets={data.buckets}
            period={period}
          />
        </>
      )}
    </section>
  );
}

interface BucketChartProps {
  tracker: Tracker;
  buckets: { start: string; end: string; label: string; value: number; count: number }[];
  period: BucketPeriod;
}

/** A dependency-free CSS column chart of bucketed values. */
function BucketChart({ tracker, buckets, period }: BucketChartProps) {
  const max = buckets.reduce((m, b) => Math.max(m, b.value), 0);

  if (buckets.length === 0 || max === 0) {
    return <p className="muted chart__empty">No entries logged in this range yet.</p>;
  }

  return (
    <div
      className="chart"
      role="img"
      aria-label={`${tracker.name} totals by ${period}`}
    >
      {buckets.map((b) => {
        const heightPct = max > 0 ? (b.value / max) * 100 : 0;
        return (
          <div className="chart__col" key={b.label}>
            <div className="chart__bar-track">
              <div
                className="chart__bar"
                style={{ height: `${heightPct}%`, background: tracker.color }}
                title={`${formatValue(tracker, b.value)} · ${b.label}`}
              />
            </div>
            <span className="chart__label">{labelFor(b.start, period)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Compact x-axis label for a bucket, by period. */
function labelFor(startIso: string, period: BucketPeriod): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return '';
  switch (period) {
    case 'day':
    case 'week':
      return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    case 'month':
      return d.toLocaleDateString(undefined, { month: 'short' });
    case 'year':
      return String(d.getFullYear());
  }
}
