import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tracker, CompositionSlice } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue } from '../lib/format.ts';
import { donutArcPath, percentShares } from '../lib/donut.ts';
import { resetPeriodOptions } from '../lib/range.ts';

interface CompositionSectionProps {
  tracker: Tracker;
  /**
   * `occurred_at` of the tracker's earliest contributing entry, if any —
   * bounds how far back the period dropdown reaches.
   */
  earliest?: string | undefined;
}

/**
 * "Composition" card for a derived tracker with two or more sources: a donut
 * of how much each source contributes to the total, with a legend carrying
 * names, signed values and percentages. When a derivation subtracts
 * (Profit = Revenue − Expenses) the slices are sized by each source's
 * *absolute* contribution — its share of the total movement — subtracting
 * slices are hatched, and the center shows the net total.
 *
 * Defaults to all time; a tracker with a reset period also gets a dropdown
 * of its historical windows (this year / last year / 2024…, per its period).
 */
export function CompositionSection({ tracker, earliest }: CompositionSectionProps) {
  const core = useCore();
  // 'all', or the `value` (bucket-start ISO) of a period option.
  const [selected, setSelected] = useState('all');
  const options = useMemo(
    () => resetPeriodOptions(tracker.reset_period, tracker.week_start, earliest),
    [tracker.reset_period, tracker.week_start, earliest],
  );
  const active = options.find((o) => o.value === selected);

  const { data: slices } = useAsync(
    () => core.stats.composition(tracker.id, active?.range),
    [tracker.id, active?.range.start, active?.range.end],
  );

  // A single operand has no breakdown to show.
  if (!slices || slices.length < 2) return null;

  const net = slices.reduce((s, slice) => s + slice.total, 0);
  const hasNegative = slices.some((s) => s.total < 0);
  const percents = percentShares(slices.map((s) => Math.abs(s.total)));
  const windowWord = active ? 'total' : 'all-time total';

  return (
    <section className="detail__composition card">
      <div className="composition__head">
        <h2>Composition</h2>
        {options.length > 0 && (
          <select
            className="composition__period"
            aria-label="Composition period"
            value={active ? selected : 'all'}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="all">All time</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="muted composition__subtitle">
        {hasNegative
          ? `How much each source moves the ${windowWord}; hatched slices subtract.`
          : `How the sources add up to the ${windowWord}.`}
      </p>
      {slices.every((s) => s.total === 0) ? (
        <p className="muted">
          {active
            ? 'Nothing logged by the sources in this period.'
            : 'Nothing logged by the sources yet.'}
        </p>
      ) : (
        <div className="composition">
          <CompositionDonut
            tracker={tracker}
            slices={slices}
            net={net}
            percents={percents}
            windowLabel={active ? centerLabel(active.label) : 'all time'}
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
  windowLabel,
}: {
  tracker: Tracker;
  slices: CompositionSlice[];
  net: number;
  percents: number[];
  windowLabel: string;
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
      aria-label={`${tracker.name} composition (${windowLabel}): ${slices
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
        {windowLabel}
      </text>
    </svg>
  );
}

/** Legend swatch mirrors the slice: solid for adding, hatched for subtracting. */
function swatchFill(slice: CompositionSlice): string {
  if (slice.total >= 0) return slice.color;
  return `repeating-linear-gradient(45deg, ${slice.color} 0 2px, color-mix(in srgb, ${slice.color} 35%, transparent) 2px 4px)`;
}

/** "This year" → "this year" under the number; date labels stay as-is. */
function centerLabel(label: string): string {
  return /^(This|Last|Today|Yesterday)/.test(label)
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}
