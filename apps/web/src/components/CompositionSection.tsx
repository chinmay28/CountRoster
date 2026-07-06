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
 * One drawable slice of the composition ring. Depending on the mode this is
 * a source tracker or the synthesized "Net" remainder, so it carries its own
 * display fields rather than reusing CompositionSlice directly.
 */
interface RingSlice {
  key: string;
  name: string;
  color: string;
  /** Linked source tracker, when the slice is one. */
  sourceId?: string;
  /** Signed value for the legend. */
  value: number;
  /** Non-negative share of the ring. */
  portion: number;
  /** Drawn hatched — this slice is subtracted from the whole. */
  hatched: boolean;
}

/**
 * How the ring reads, by the signs of the contributions:
 *
 * - `additive` — every source adds. The whole is the total; slices are the
 *   sources (the classic part-to-whole donut).
 * - `breakdown` — some sources subtract, but the positive ones outweigh
 *   them. The whole is the *added* total (e.g. gross cashback); slices are
 *   what each subtraction takes (hatched) plus the net that remains — the
 *   positive sources aren't slices, they ARE the ring.
 * - `movement` — subtractions overwhelm the additions (negative or zero
 *   gross/net), so "share of the whole" breaks down; fall back to sizing
 *   every source by its absolute movement around the net.
 */
type RingMode = 'additive' | 'breakdown' | 'movement';

/**
 * "Composition" card for a derived tracker with two or more sources: a donut
 * of how the total is composed, with a legend carrying names, signed values
 * and percentages (see RingMode for how mixed-sign derivations read).
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
  const gross = slices.reduce((s, slice) => s + Math.max(0, slice.total), 0);
  const hasNegative = slices.some((s) => s.total < 0);
  const mode: RingMode = !hasNegative
    ? 'additive'
    : gross > 0 && net >= 0
      ? 'breakdown'
      : 'movement';

  // The positive sources a breakdown ring is made *of* (legend-only rows).
  const wholeRows = mode === 'breakdown' ? slices.filter((s) => s.total > 0) : [];
  const ring: RingSlice[] =
    mode === 'breakdown'
      ? [
          ...slices
            .filter((s) => s.total <= 0)
            .map((s) => sourceSlice(s, -s.total)),
          {
            key: 'net',
            name: 'Net',
            color: tracker.color,
            value: net,
            portion: net,
            hatched: false,
          },
        ]
      : slices.map((s) => sourceSlice(s, Math.abs(s.total)));
  const percents = percentShares(ring.map((r) => r.portion));
  // The center is the ring's whole: the gross for a breakdown, else the net.
  const center = mode === 'breakdown' ? gross : net;

  const windowWord = active ? 'total' : 'all-time total';
  const subtitle =
    mode === 'additive'
      ? `How the sources add up to the ${windowWord}.`
      : mode === 'breakdown'
        ? `How ${
            wholeRows.length === 1 ? wholeRows[0]!.name : `the added ${windowWord}`
          } splits between what's subtracted (hatched) and the net.`
        : `How much each source moves the ${windowWord}; hatched slices subtract.`;

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
      <p className="muted composition__subtitle">{subtitle}</p>
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
            ring={ring}
            center={center}
            percents={percents}
            windowLabel={active ? centerLabel(active.label) : 'all time'}
          />
          <ul className="composition__legend">
            {/* What the whole ring is made of — a hollow swatch, no share. */}
            {wholeRows.map((s) => (
              <li key={s.source_id} className="composition__item">
                <span
                  className="composition__swatch composition__swatch--whole"
                  style={{ borderColor: s.color }}
                  aria-hidden="true"
                />
                <Link to={`/trackers/${s.source_id}`}>{s.name}</Link>
                <span className="muted composition__share">
                  {formatValue(tracker, s.total)}
                </span>
              </li>
            ))}
            {ring.map((r, i) => (
              <li key={r.key} className="composition__item">
                <span
                  className="composition__swatch"
                  style={{ background: swatchFill(r) }}
                  aria-hidden="true"
                />
                {r.sourceId ? (
                  <Link to={`/trackers/${r.sourceId}`}>{r.name}</Link>
                ) : (
                  <span>{r.name}</span>
                )}
                <span className="muted composition__share">
                  {formatValue(tracker, r.value)} · {percents[i]}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A ring slice backed by a real source tracker. */
function sourceSlice(s: CompositionSlice, portion: number): RingSlice {
  return {
    key: s.source_id,
    sourceId: s.source_id,
    name: s.name,
    color: s.color,
    value: s.total,
    portion,
    hatched: s.total < 0,
  };
}

/** Donut geometry (viewBox units). */
const SIZE = 160;
const CENTER = SIZE / 2;
const R_OUTER = 76;
const R_INNER = 50;

function CompositionDonut({
  tracker,
  ring,
  center,
  percents,
  windowLabel,
}: {
  tracker: Tracker;
  ring: RingSlice[];
  center: number;
  percents: number[];
  windowLabel: string;
}) {
  // Cumulative shares → one annular sector per non-empty slice. Zero-portion
  // slices draw nothing (the legend still lists them at 0%).
  const sum = ring.reduce((s, r) => s + r.portion, 0);
  let cursor = 0;
  const arcs = ring.map((r, i) => {
    const start = cursor;
    cursor += r.portion / sum;
    return { r, start, end: cursor, percent: percents[i]! };
  });

  return (
    <svg
      className="composition__donut"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`${tracker.name} composition (${windowLabel}): ${ring
        .map((r, i) =>
          r.hatched
            ? `${r.name} subtracts ${percents[i]}%`
            : `${r.name === 'Net' ? 'net' : r.name} ${percents[i]}%`,
        )
        .join(', ')}`}
    >
      <defs>
        {/* Tone-on-tone 45° hatch marking the slices that subtract. */}
        {ring
          .filter((r) => r.hatched)
          .map((r) => (
            <pattern
              key={r.key}
              id={`hatch-${r.key}`}
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill={r.color} opacity="0.35" />
              <rect width="3" height="6" fill={r.color} />
            </pattern>
          ))}
      </defs>
      {arcs.map(({ r, start, end, percent }) => {
        if (end - start <= 0) return null;
        const label = `${r.name}: ${
          r.hatched ? 'subtracts ' : ''
        }${formatValue(tracker, Math.abs(r.value))} (${percent}%)`;
        const fill = r.hatched ? `url(#hatch-${r.key})` : r.color;
        // A slice that is the whole circle has coincident arc endpoints, so
        // its path degenerates — draw the full ring as a stroked circle.
        if (end - start >= 0.9999) {
          return (
            <circle
              key={r.key}
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
            key={r.key}
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
        {formatValue(tracker, center)}
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
function swatchFill(slice: RingSlice): string {
  if (!slice.hatched) return slice.color;
  return `repeating-linear-gradient(45deg, ${slice.color} 0 2px, color-mix(in srgb, ${slice.color} 35%, transparent) 2px 4px)`;
}

/** "This year" → "this year" under the number; date labels stay as-is. */
function centerLabel(label: string): string {
  return /^(This|Last|Today|Yesterday)/.test(label)
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}
