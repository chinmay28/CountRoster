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
 * "Composition" card for a derived tracker with two or more sources: a donut
 * of how much each source contributes to the all-time total, with a legend
 * carrying names, signed values and percentages. When a derivation subtracts
 * (Profit = Revenue − Expenses) the slices are sized by each source's
 * *absolute* contribution — its share of the total movement — subtracting
 * slices are hatched, and the center shows the net total.
 */
export function CompositionSection({ tracker }: CompositionSectionProps) {
  const core = useCore();
  const { data: slices } = useAsync(
    () => core.stats.composition(tracker.id),
    [tracker.id],
  );

  // A single operand has no breakdown to show.
  if (!slices || slices.length < 2) return null;

  const net = slices.reduce((s, slice) => s + slice.total, 0);
  const hasNegative = slices.some((s) => s.total < 0);
  const percents = percentShares(slices.map((s) => Math.abs(s.total)));

  return (
    <section className="detail__composition card">
      <h2>Composition</h2>
      <p className="muted composition__subtitle">
        {hasNegative
          ? 'How much each source moves the all-time total; hatched slices subtract.'
          : 'How the sources add up to the all-time total.'}
      </p>
      {slices.every((s) => s.total === 0) ? (
        <p className="muted">Nothing logged by the sources yet.</p>
      ) : (
        <div className="composition">
          <CompositionDonut
            tracker={tracker}
            slices={slices}
            net={net}
            percents={percents}
          />
          <ul className="composition__legend">
            {slices.map((slice, i) => (
              <li key={slice.source_id} className="composition__item">
                <span
                  className="composition__swatch"
                  style={{ background: swatchFill(slice) }}
                  aria-hidden="true"
                />
                <Link to={`/trackers/${slice.source_id}`}>{slice.name}</Link>
                <span className="muted composition__share">
                  {formatValue(tracker, slice.total)} · {percents[i]}%
                </span>
              </li>
            ))}
          </ul>
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
  net,
  percents,
}: {
  tracker: Tracker;
  slices: CompositionSlice[];
  net: number;
  percents: number[];
}) {
  // Cumulative |total| shares → one annular sector per non-empty slice.
  // Zero-total slices draw nothing (the legend still lists them at 0%).
  const sumAbs = slices.reduce((s, slice) => s + Math.abs(slice.total), 0);
  let cursor = 0;
  const arcs = slices.map((slice, i) => {
    const start = cursor;
    cursor += Math.abs(slice.total) / sumAbs;
    return { slice, start, end: cursor, percent: percents[i]! };
  });

  return (
    <svg
      className="composition__donut"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`${tracker.name} composition: ${slices
        .map(
          (s, i) => `${s.name} ${s.total < 0 ? 'subtracts ' : ''}${percents[i]}%`,
        )
        .join(', ')}`}
    >
      <defs>
        {/* Tone-on-tone 45° hatch marking the slices that subtract. */}
        {slices
          .filter((s) => s.total < 0)
          .map((s) => (
            <pattern
              key={s.source_id}
              id={`hatch-${s.source_id}`}
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill={s.color} opacity="0.35" />
              <rect width="3" height="6" fill={s.color} />
            </pattern>
          ))}
      </defs>
      {arcs.map(({ slice, start, end, percent }) => {
        if (end - start <= 0) return null;
        const label = `${slice.name}: ${
          slice.total < 0 ? 'subtracts ' : ''
        }${formatValue(tracker, Math.abs(slice.total))} (${percent}%)`;
        const fill =
          slice.total < 0 ? `url(#hatch-${slice.source_id})` : slice.color;
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
              stroke={fill}
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
            fill={fill}
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
        {formatValue(tracker, net)}
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

/** Legend swatch mirrors the slice: solid for adding, hatched for subtracting. */
function swatchFill(slice: CompositionSlice): string {
  if (slice.total >= 0) return slice.color;
  return `repeating-linear-gradient(45deg, ${slice.color} 0 2px, color-mix(in srgb, ${slice.color} 35%, transparent) 2px 4px)`;
}
