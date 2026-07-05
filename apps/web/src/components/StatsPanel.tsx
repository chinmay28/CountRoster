import { useMemo, useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { Tracker, BucketPeriod } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue } from '../lib/format.ts';
import { lastNBuckets } from '../lib/range.ts';
import { PlotFigure } from './PlotFigure.tsx';

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
  const isSnapshot = tracker.is_snapshot === 1;

  const { data, loading, error } = useAsync(async () => {
    const range = lastNBuckets(period, count, tracker.week_start);
    const [buckets, streak, target, extremes] = await Promise.all([
      core.stats.bucket(tracker.id, range, period),
      core.stats.streak(tracker.id),
      core.stats.targetProgress(tracker.id),
      // A snapshot stat's headline numbers are its all-time high and low —
      // computed over every entry, not just the charted range.
      isSnapshot
        ? core.entries.forTracker(tracker.id).then(allTimeExtremes)
        : Promise.resolve(null),
    ]);
    return { buckets, streak, target, extremes };
  }, [tracker.id, period, count, refreshKey, isSnapshot]);

  // The streak only makes sense for daily logging. For coarser periods,
  // summarize the bucket totals (mean / median / range) instead. Snapshot
  // trackers show all-time high/low regardless of period.
  const summary = data ? summarizeBuckets(data.buckets) : null;

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
            {isSnapshot ? (
              data.extremes && (
                <div className="stat-card">
                  <span className="stat-card__value">
                    {formatValue(tracker, data.extremes.high)}
                  </span>
                  <span className="stat-card__label">
                    all-time high · all-time low{' '}
                    {formatValue(tracker, data.extremes.low)}
                  </span>
                </div>
              )
            ) : period === 'day' ? (
              <div className="stat-card">
                <span className="stat-card__value">🔥 {data.streak.current}</span>
                <span className="stat-card__label">
                  day streak · best {data.streak.longest}
                </span>
              </div>
            ) : (
              summary && (
                <div className="stat-card">
                  <span className="stat-card__value">
                    {formatValue(tracker, summary.mean)}
                  </span>
                  <span className="stat-card__label">
                    mean per {period} · median {formatValue(tracker, summary.median)} ·
                    range {formatValue(tracker, summary.min)}–
                    {formatValue(tracker, summary.max)}
                  </span>
                </div>
              )
            )}
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
                  {isSnapshot ? 'toward target' : 'this period'} ·{' '}
                  {Math.round((data.target.ratio ?? 0) * 100)}%
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

/** All-time high and low readings of a snapshot tracker; null when empty. */
function allTimeExtremes(
  entries: { value: number }[],
): { high: number; low: number } | null {
  if (entries.length === 0) return null;
  let high = entries[0]!.value;
  let low = entries[0]!.value;
  for (const e of entries) {
    if (e.value > high) high = e.value;
    if (e.value < low) low = e.value;
  }
  return { high, low };
}

interface BucketSummary {
  mean: number;
  median: number;
  min: number;
  max: number;
}

/**
 * Descriptive stats over the *non-empty* buckets in a range. Empty buckets
 * (periods with nothing logged) are excluded so the min–max range stays
 * meaningful — otherwise the minimum would almost always be zero. Returns null
 * when nothing was logged in the range.
 */
function summarizeBuckets(buckets: { value: number; count: number }[]): BucketSummary | null {
  const values = buckets
    .filter((b) => b.count > 0)
    .map((b) => b.value)
    .sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
  return { mean, median, min: values[0]!, max: values[n - 1]! };
}

interface BucketChartProps {
  tracker: Tracker;
  buckets: { start: string; end: string; label: string; value: number; count: number }[];
  period: BucketPeriod;
}

/**
 * The bucketed trend chart (Observable Plot) with axes and hover tooltips:
 * bars of per-period totals — or, for a snapshot tracker, a line through the
 * last reading of each period (levels, not amounts, so bars from zero would
 * misread; empty periods are skipped rather than drawn as zero).
 */
function BucketChart({ tracker, buckets, period }: BucketChartProps) {
  const isSnapshot = tracker.is_snapshot === 1;
  const hasData = isSnapshot
    ? buckets.some((b) => b.count > 0)
    : buckets.reduce((m, b) => Math.max(m, b.value), 0) > 0;

  const options = useMemo<Plot.PlotOptions>(() => {
    const data = buckets
      .filter((b) => !isSnapshot || b.count > 0)
      .map((b) => ({
        bucket: labelFor(b.start, period),
        label: b.label,
        value: b.value,
        pretty: formatValue(tracker, b.value),
      }));
    const tip = {
      title: (d: { label: string; pretty: string }) => `${d.label}: ${d.pretty}`,
      tip: true,
    };
    return {
      height: 200,
      marginLeft: 48,
      marginBottom: 30,
      // `data` arrives from the core already in chronological order. The x scale
      // is ordinal (bucket labels), and Plot would otherwise sort that domain
      // naturally — e.g. month names alphabetically (Apr, Aug, Dec…). Pin the
      // domain to the data order so marks read left-to-right by date. For a
      // snapshot the domain keeps even the skipped (empty) buckets so the time
      // axis stays evenly spaced.
      x: {
        label: null,
        domain: buckets.map((b) => labelFor(b.start, period)),
      },
      y: { label: tracker.unit ?? null, grid: true, ticks: 4 },
      marks: isSnapshot
        ? [
            Plot.lineY(data, { x: 'bucket', y: 'value', stroke: tracker.color }),
            Plot.dot(data, { x: 'bucket', y: 'value', fill: tracker.color, ...tip }),
          ]
        : [
            Plot.barY(data, { x: 'bucket', y: 'value', fill: tracker.color, ...tip }),
            Plot.ruleY([0]),
          ],
    };
    // tracker.kind affects formatValue output; include it so tips stay correct.
  }, [buckets, period, isSnapshot, tracker.color, tracker.unit, tracker.kind, tracker.name]);

  if (buckets.length === 0 || !hasData) {
    return <p className="muted chart__empty">No entries logged in this range yet.</p>;
  }

  return (
    <PlotFigure
      className="chart-fig"
      options={options}
      ariaLabel={`${tracker.name} ${isSnapshot ? 'levels' : 'totals'} by ${period}`}
    />
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
