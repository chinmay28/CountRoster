import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { Tracker, Entry, BucketPeriod } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue, formatDateTime } from '../lib/format.ts';
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

/**
 * Charts & stats for a tracker. An ordinary tracker gets period-bucketed
 * totals (Day/Week/Month/Year toggle, bar chart, streak card); a snapshot
 * tracker gets a zoomable line of its raw readings over time — periods don't
 * apply to point-in-time levels.
 */
export function StatsPanel({ tracker, refreshKey }: StatsPanelProps) {
  return tracker.is_snapshot === 1 ? (
    <SnapshotStats tracker={tracker} refreshKey={refreshKey} />
  ) : (
    <BucketedStats tracker={tracker} refreshKey={refreshKey} />
  );
}

/** Bucketed totals for an ordinary tracker: streak, target, bar chart. */
function BucketedStats({ tracker, refreshKey }: StatsPanelProps) {
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

  // The streak only makes sense for daily logging. For coarser periods,
  // summarize the bucket totals (mean / median / range) instead.
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
            {period === 'day' ? (
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
            <TargetCard tracker={tracker} target={data.target} label="this period" />
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

/**
 * Snapshot trackers chart their raw readings on a continuous time axis — no
 * period toggle, since levels aren't summed into buckets. The visible window
 * is anchored at the most recent reading and zooms continuously: pinch the
 * chart (or ctrl+scroll — how browsers report a trackpad pinch), or step by
 * halvings with the − / + buttons.
 */
function SnapshotStats({ tracker, refreshKey }: StatsPanelProps) {
  const core = useCore();
  // 0 shows the full history; each whole step halves the visible time
  // window. Fractional values come from pinch/scroll zooming.
  const [zoom, setZoom] = useState(0);

  const { data, loading, error } = useAsync(async () => {
    const [entries, target] = await Promise.all([
      core.entries.forTracker(tracker.id),
      core.stats.targetProgress(tracker.id),
    ]);
    return { entries, target };
  }, [tracker.id, refreshKey]);

  const entries = data?.entries ?? [];
  const extremes = allTimeExtremes(entries);

  // The deepest useful zoom: the level where only the last two readings (at
  // distinct instants) remain in view. Gestures and buttons clamp to it.
  const maxZoom = useMemo(() => {
    if (entries.length < 3) return 0;
    const startMs = new Date(entries[0]!.occurred_at).getTime();
    const endMs = new Date(entries[entries.length - 1]!.occurred_at).getTime();
    if (endMs <= startMs) return 0;
    // Walk back to the latest reading strictly before the anchor.
    for (let i = entries.length - 2; i >= 0; i--) {
      const t = new Date(entries[i]!.occurred_at).getTime();
      if (t < endMs) return Math.log2((endMs - startMs) / (endMs - t));
    }
    return 0;
  }, [entries]);

  const zoomBy = useCallback(
    (delta: number) =>
      setZoom((z) => Math.min(Math.max(z + delta, 0), maxZoom)),
    [maxZoom],
  );
  const pinchRef = usePinchZoom(zoomBy);

  // The readings inside the current zoom window, anchored at the latest one.
  const visible = useMemo(() => {
    if (entries.length === 0 || zoom === 0) return entries;
    const startMs = new Date(entries[0]!.occurred_at).getTime();
    const endMs = new Date(entries[entries.length - 1]!.occurred_at).getTime();
    const span = (endMs - startMs) / 2 ** zoom;
    return entries.filter(
      (e) => new Date(e.occurred_at).getTime() >= endMs - span,
    );
  }, [entries, zoom]);

  return (
    <section className="stats">
      <div className="stats__head">
        <h2>Trends</h2>
        <div className="stats__periods" role="group" aria-label="Zoom">
          <button
            type="button"
            className="btn btn--small"
            aria-label="Zoom out"
            onClick={() => zoomBy(-1)}
            disabled={zoom === 0}
          >
            −
          </button>
          <button
            type="button"
            className="btn btn--small"
            aria-label="Zoom in"
            onClick={() => zoomBy(1)}
            // A sliver of remaining zoom (< 5% of a halving) isn't a step.
            disabled={zoom >= maxZoom - 0.05}
          >
            +
          </button>
        </div>
      </div>

      {error && <p className="error">{error.message}</p>}
      {loading && !data && <p className="muted">Loading stats…</p>}

      {data && (
        <>
          <div className="stat-cards">
            {extremes && (
              <div className="stat-card">
                <span className="stat-card__value">
                  {formatValue(tracker, extremes.high)}
                </span>
                <span className="stat-card__label">
                  all-time high · all-time low {formatValue(tracker, extremes.low)}
                </span>
              </div>
            )}
            <TargetCard tracker={tracker} target={data.target} label="toward target" />
          </div>

          {entries.length === 0 ? (
            <p className="muted chart__empty">No readings yet.</p>
          ) : (
            <>
              <p className="muted stats__window">
                {zoom === 0
                  ? `all history · ${entries.length} reading${entries.length === 1 ? '' : 's'}`
                  : `zoomed to the latest ${visible.length} of ${entries.length} readings`}
              </p>
              <div ref={pinchRef} className="stats__zoomable">
                <SnapshotChart tracker={tracker} entries={visible} />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Pinch-to-zoom (and ctrl+scroll, the wheel event a trackpad pinch produces)
 * on the returned ref's element, reported as log2 deltas — +1 means "the
 * window halved". Listeners are attached natively with `passive: false`
 * because React's delegated touch/wheel handlers are passive, and a handled
 * pinch must preventDefault so the browser doesn't page-zoom or scroll.
 */
function usePinchZoom(onZoomBy: (log2Delta: number) => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const spread = (touches: TouchList) =>
      Math.hypot(
        touches[0]!.clientX - touches[1]!.clientX,
        touches[0]!.clientY - touches[1]!.clientY,
      );

    // The finger spread at the last processed move; null while not pinching.
    let lastSpread: number | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) lastSpread = spread(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || lastSpread == null) return;
      e.preventDefault();
      const next = spread(e.touches);
      if (next > 0 && lastSpread > 0) onZoomBy(Math.log2(next / lastSpread));
      lastSpread = next;
    };
    const onTouchEnd = () => {
      lastSpread = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain scroll passes through untouched
      e.preventDefault();
      onZoomBy(-e.deltaY / 100);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [onZoomBy]);

  return ref;
}

/** The target-progress card, shared by both panel variants. */
function TargetCard({
  tracker,
  target,
  label,
}: {
  tracker: Tracker;
  target: { target: number | null; current: number; ratio: number | null };
  label: string;
}) {
  if (target.target == null) return null;
  return (
    <div className="stat-card">
      <span className="stat-card__value">
        {formatValue(tracker, target.current)}
        <span className="muted">
          {' / '}
          {formatValue(tracker, target.target)}
        </span>
      </span>
      <span className="stat-card__label">
        {label} · {Math.round((target.ratio ?? 0) * 100)}%
      </span>
      <div className="progress" aria-hidden="true">
        <div
          className="progress__fill"
          style={{
            width: `${(target.ratio ?? 0) * 100}%`,
            background: tracker.color,
          }}
        />
      </div>
    </div>
  );
}

/** All-time high and low readings of a snapshot tracker; null when empty. */
function allTimeExtremes(
  entries: readonly { value: number }[],
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

/**
 * A line through every reading in the window, on a real time scale (uneven
 * gaps between readings stay uneven, unlike ordinal bucket labels).
 */
function SnapshotChart({
  tracker,
  entries,
}: {
  tracker: Tracker;
  entries: readonly Entry[];
}) {
  const options = useMemo<Plot.PlotOptions>(() => {
    const data = entries.map((e) => ({
      when: new Date(e.occurred_at),
      value: e.value,
      pretty: `${formatDateTime(e.occurred_at)}: ${formatValue(tracker, e.value)}`,
    }));
    return {
      height: 200,
      marginLeft: 48,
      marginBottom: 30,
      x: { label: null },
      y: { label: tracker.unit ?? null, grid: true, ticks: 4 },
      marks: [
        Plot.lineY(data, { x: 'when', y: 'value', stroke: tracker.color }),
        Plot.dot(data, {
          x: 'when',
          y: 'value',
          fill: tracker.color,
          title: (d: { pretty: string }) => d.pretty,
          tip: true,
        }),
      ],
    };
    // tracker.kind affects formatValue output; include it so tips stay correct.
  }, [entries, tracker.color, tracker.unit, tracker.kind, tracker.name]);

  return (
    <PlotFigure
      className="chart-fig"
      options={options}
      ariaLabel={`${tracker.name} level over time`}
    />
  );
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

/** A bucketed bar chart (Observable Plot) with axes and hover tooltips. */
function BucketChart({ tracker, buckets, period }: BucketChartProps) {
  const max = buckets.reduce((m, b) => Math.max(m, b.value), 0);

  const options = useMemo<Plot.PlotOptions>(() => {
    const data = buckets.map((b) => ({
      bucket: labelFor(b.start, period),
      label: b.label,
      value: b.value,
      pretty: formatValue(tracker, b.value),
    }));
    return {
      height: 200,
      marginLeft: 48,
      marginBottom: 30,
      // `data` arrives from the core already in chronological order. The x scale
      // is ordinal (bucket labels), and Plot would otherwise sort that domain
      // naturally — e.g. month names alphabetically (Apr, Aug, Dec…). Pin the
      // domain to the data order so bars read left-to-right by date.
      x: { label: null, domain: data.map((d) => d.bucket) },
      y: { label: tracker.unit ?? null, grid: true, ticks: 4 },
      marks: [
        Plot.barY(data, {
          x: 'bucket',
          y: 'value',
          fill: tracker.color,
          title: (d: { label: string; pretty: string }) => `${d.label}: ${d.pretty}`,
          tip: true,
        }),
        Plot.ruleY([0]),
      ],
    };
    // tracker.kind affects formatValue output; include it so tips stay correct.
  }, [buckets, period, tracker.color, tracker.unit, tracker.kind, tracker.name]);

  if (buckets.length === 0 || max === 0) {
    return <p className="muted chart__empty">No entries logged in this range yet.</p>;
  }

  return (
    <PlotFigure
      className="chart-fig"
      options={options}
      ariaLabel={`${tracker.name} totals by ${period}`}
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
