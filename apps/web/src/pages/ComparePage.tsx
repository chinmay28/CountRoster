import { useEffect, useMemo, useState } from 'react';
import * as Plot from '@observablehq/plot';
import type { BucketPeriod, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { PlotFigure } from '../components/PlotFigure.tsx';
import { lastNBuckets } from '../lib/range.ts';

const PERIODS: { period: BucketPeriod; label: string; count: number }[] = [
  { period: 'day', label: 'Day', count: 30 },
  { period: 'week', label: 'Week', count: 12 },
  { period: 'month', label: 'Month', count: 12 },
];

interface Point {
  tracker: string;
  date: Date;
  value: number;
}

/** Compare several trackers' totals over time on one multi-series chart. */
export function ComparePage() {
  const core = useCore();
  const trackers = useAsync(() => core.trackers.list(), []);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<BucketPeriod>('week');
  const [initialized, setInitialized] = useState(false);
  const count = PERIODS.find((p) => p.period === period)!.count;

  // Default to the first few trackers once they load — but only once, so
  // deselecting everything doesn't snap the defaults back.
  const list = trackers.data;
  useEffect(() => {
    if (!initialized && list && list.length > 0) {
      setSelected(new Set(list.slice(0, Math.min(3, list.length)).map((t) => t.id)));
      setInitialized(true);
    }
  }, [initialized, list]);

  const selectedKey = [...selected].sort().join(',');
  const series = useAsync(async () => {
    if (!list || selected.size === 0) return { points: [] as Point[], chosen: [] as Tracker[] };
    const chosen = list.filter((t) => selected.has(t.id));
    const range = lastNBuckets(period, count, 1);
    const points: Point[] = [];
    await Promise.all(
      chosen.map(async (t) => {
        const buckets = await core.stats.bucket(t.id, range, period);
        for (const b of buckets) {
          points.push({ tracker: t.name, date: new Date(b.start), value: b.value });
        }
      }),
    );
    return { points, chosen };
  }, [selectedKey, period, count, Boolean(list)]);

  const options = useMemo<Plot.PlotOptions>(() => {
    const points = series.data?.points ?? [];
    const chosen = series.data?.chosen ?? [];
    return {
      height: 300,
      marginLeft: 50,
      marginBottom: 30,
      x: { label: null, type: 'utc' },
      y: { label: null, grid: true },
      color: {
        legend: true,
        domain: chosen.map((t) => t.name),
        range: chosen.map((t) => t.color),
      },
      marks: [
        Plot.ruleY([0]),
        Plot.lineY(points, {
          x: 'date',
          y: 'value',
          stroke: 'tracker',
          z: 'tracker',
          curve: 'monotone-x',
          strokeWidth: 2,
        }),
        Plot.dot(points, {
          x: 'date',
          y: 'value',
          fill: 'tracker',
          r: 2.5,
          title: (d: Point) => `${d.tracker}: ${d.value}`,
          tip: true,
        }),
      ],
    };
  }, [series.data]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (trackers.loading) return <p className="muted">Loading…</p>;
  if (trackers.error) return <p className="error">{trackers.error.message}</p>;
  if (!list || list.length === 0) {
    return (
      <div className="empty">
        <h1>Nothing to compare yet</h1>
        <p>Create a couple of trackers and log some entries first.</p>
      </div>
    );
  }

  const hasPoints = (series.data?.points.length ?? 0) > 0;

  return (
    <section className="form-page">
      <div className="stats__head">
        <h1 className="page-title">Compare trackers</h1>
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

      <div className="compare__picker">
        {list.map((t) => (
          <label key={t.id} className="compare__chip">
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => toggle(t.id)}
            />
            <span className="compare__swatch" style={{ background: t.color }} />
            {t.name}
          </label>
        ))}
      </div>

      {selected.size === 0 ? (
        <p className="muted">Select one or more trackers to compare.</p>
      ) : !hasPoints ? (
        <p className="muted">No entries in this range for the selected trackers.</p>
      ) : (
        <PlotFigure
          className="chart-fig"
          options={options}
          ariaLabel="Tracker comparison over time"
        />
      )}
    </section>
  );
}
