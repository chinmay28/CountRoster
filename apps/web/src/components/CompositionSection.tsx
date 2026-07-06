import { Link } from 'react-router-dom';
import type { Tracker, CompositionSlice } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue } from '../lib/format.ts';
import { donutArcPath, percentShares } from '../lib/donut.ts';

interface CompositionSectionProps {
  tracker: Tracker;
}

/**
 * "Composition" card for a derived tracker whose derivation is purely
 * additive (two or more sources, all positive coefficients): a donut of each
 * source's share of the all-time total, with a legend carrying names, values
 * and percentages. Renders nothing for subtractive/scaled-down derivations —
 * a percentage breakdown only means something when the parts add up to the
 * whole.
 */
export function CompositionSection({ tracker }: CompositionSectionProps) {
  const core = useCore();
  const { data: slices } = useAsync(
    () => core.stats.composition(tracker.id),
    [tracker.id],
  );

  if (!slices || slices.length < 2 || slices.some((s) => s.coefficient <= 0)) {
    return null;
  }

  const total = slices.reduce((s, slice) => s + slice.total, 0);
  // Negative source sums (e.g. a corrections-heavy tracker) break shares-of-
  // a-whole; keep the legend's absolute values but skip the donut and
  // percentages rather than draw a lying chart.
  const chartable = total > 0 && slices.every((s) => s.total >= 0);
  const percents = chartable ? percentShares(slices.map((s) => s.total)) : null;

  return (
    <section className="detail__composition card">
      <h2>Composition</h2>
      <p className="muted composition__subtitle">
        How the sources add up to the all-time total.
      </p>
      {total === 0 && slices.every((s) => s.count === 0) ? (
        <p className="muted">Nothing logged by the sources yet.</p>
      ) : (
        <div className="composition">
          {chartable && (
            <CompositionDonut
              tracker={tracker}
              slices={slices}
              total={total}
              percents={percents!}
            />
          )}
          <ul className="composition__legend">
            {slices.map((slice, i) => (
              <li key={slice.source_id} className="composition__item">
                <span
                  className="composition__swatch"
                  style={{ background: slice.color }}
                  aria-hidden="true"
                />
                <Link to={`/trackers/${slice.source_id}`}>{slice.name}</Link>
                <span className="muted composition__share">
                  {formatValue(tracker, slice.total)}
                  {percents ? ` · ${percents[i]}%` : ''}
                </span>
              </li>
            ))}
          </ul>
          {!chartable && (
            <p className="muted composition__note">
              Percentages aren't shown while a source total is negative.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Donut geometry (viewBox units). */
const SIZE = 160;
const CENTER = SIZE / 2;
const R_OUTER = 76;
const R_INNER = 50;

function CompositionDonut({
  tracker,
  slices,
  total,
  percents,
}: {
  tracker: Tracker;
  slices: CompositionSlice[];
  total: number;
  percents: number[];
}) {
  // Cumulative shares → one annular sector per non-empty slice. Zero-total
  // slices draw nothing (the legend still lists them at 0%).
  let cursor = 0;
  const arcs = slices.map((slice, i) => {
    const start = cursor;
    cursor += slice.total / total;
    return { slice, start, end: cursor, percent: percents[i]! };
  });

  return (
    <svg
      className="composition__donut"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`${tracker.name} composition: ${slices
        .map((s, i) => `${s.name} ${percents[i]}%`)
        .join(', ')}`}
    >
      {arcs.map(({ slice, start, end, percent }) => {
        if (end - start <= 0) return null;
        const label = `${slice.name}: ${formatValue(tracker, slice.total)} (${percent}%)`;
        // A slice that is the whole circle has coincident arc endpoints, so
        // its path degenerates — draw the full ring as a stroked circle.
        if (end - start >= 0.9999) {
          return (
            <circle
              key={slice.source_id}
              cx={CENTER}
              cy={CENTER}
              r={(R_OUTER + R_INNER) / 2}
              fill="none"
              stroke={slice.color}
              strokeWidth={R_OUTER - R_INNER}
            >
              <title>{label}</title>
            </circle>
          );
        }
        return (
          <path
            key={slice.source_id}
            d={donutArcPath(start, end, CENTER, CENTER, R_OUTER, R_INNER)}
            fill={slice.color}
            stroke="var(--surface)"
            strokeWidth={2}
          >
            <title>{label}</title>
          </path>
        );
      })}
      <text
        x={CENTER}
        y={CENTER - 2}
        textAnchor="middle"
        className="composition__donut-total"
      >
        {formatValue(tracker, total)}
      </text>
      <text
        x={CENTER}
        y={CENTER + 16}
        textAnchor="middle"
        className="composition__donut-label"
      >
        all time
      </text>
    </svg>
  );
}
