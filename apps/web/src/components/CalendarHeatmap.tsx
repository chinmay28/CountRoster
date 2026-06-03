import { useMemo } from 'react';
import * as Plot from '@observablehq/plot';
import type { Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue, formatDate } from '../lib/format.ts';
import { lastNBuckets } from '../lib/range.ts';
import { PlotFigure } from './PlotFigure.tsx';

const WEEKS = 53;
const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface CalendarHeatmapProps {
  tracker: Tracker;
  refreshKey: number;
}

/** A GitHub-style daily-activity heatmap for the last ~year. */
export function CalendarHeatmap({ tracker, refreshKey }: CalendarHeatmapProps) {
  const core = useCore();

  const { data, loading, error } = useAsync(async () => {
    // One cell per day for the last WEEKS weeks.
    const range = lastNBuckets('day', WEEKS * 7, tracker.week_start);
    return core.stats.bucket(tracker.id, range, 'day');
  }, [tracker.id, refreshKey]);

  const cells = useMemo(() => {
    if (!data || data.length === 0) return [];
    const first = new Date(data[0]!.start);
    // Align column 0 to the Sunday on/just before the first day.
    const firstSunday = new Date(first);
    firstSunday.setHours(0, 0, 0, 0);
    firstSunday.setDate(firstSunday.getDate() - firstSunday.getDay());
    const DAY = 86_400_000;
    return data.map((b) => {
      const d = new Date(b.start);
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      const week = Math.floor((day.getTime() - firstSunday.getTime()) / DAY / 7);
      return {
        week,
        dow: d.getDay(),
        value: b.value,
        date: d,
        pretty: formatValue(tracker, b.value),
      };
    });
  }, [data, tracker.kind, tracker.unit]);

  const maxValue = cells.reduce((m, c) => Math.max(m, c.value), 0);

  const options = useMemo<Plot.PlotOptions>(
    () => ({
      width: WEEKS * 15 + 40,
      height: 7 * 15 + 30,
      marginTop: 12,
      marginLeft: 28,
      padding: 0.15,
      x: { axis: null },
      y: {
        domain: [0, 1, 2, 3, 4, 5, 6],
        tickFormat: (i: number) => DOW_LETTERS[i] ?? '',
        tickSize: 0,
        label: null,
      },
      color: {
        type: 'linear',
        scheme: 'greens',
        domain: [0, maxValue || 1],
        // No Plot legend here: its continuous ramp renders to a <canvas>, which
        // jsdom can't do. We draw a small CSS legend below instead.
      },
      marks: [
        Plot.cell(cells, {
          x: 'week',
          y: 'dow',
          fill: 'value',
          inset: 1,
          rx: 2,
          title: (d: { date: Date; pretty: string }) =>
            `${formatDate(d.date.toISOString())}: ${d.pretty}`,
          tip: true,
        }),
      ],
    }),
    [cells, maxValue, tracker.name],
  );

  if (loading && !data) return <p className="muted">Loading activity…</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (cells.length === 0) return null;

  return (
    <div className="heatmap">
      <h3 className="heatmap__title">Daily activity</h3>
      {/* The heatmap is intrinsically wide; it scrolls rather than shrinks. */}
      <div className="heatmap__scroll">
        <PlotFigure
          options={options}
          ariaLabel={`${tracker.name} daily activity calendar`}
          responsive={false}
        />
      </div>
      <div className="heatmap__legend">
        <span className="muted">Less</span>
        <span className="heatmap__ramp" aria-hidden="true" />
        <span className="muted">More</span>
      </div>
    </div>
  );
}
