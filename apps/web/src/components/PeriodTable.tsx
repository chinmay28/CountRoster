import { useMemo, useState } from 'react';
import type { BucketPeriod, StatBucket, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue, formatNumber } from '../lib/format.ts';
import { lastNBuckets, periodForReset, periodRowLabel } from '../lib/range.ts';

/** Period toggle, coarsest resolution last. */
const PERIODS: { period: BucketPeriod; label: string }[] = [
  { period: 'day', label: 'Day' },
  { period: 'week', label: 'Week' },
  { period: 'month', label: 'Month' },
  { period: 'year', label: 'Year' },
];

/** How many periods a page shows, and how many more "Show more" adds. */
const PAGE_SIZE = 12;

interface PeriodTableProps {
  tracker: Tracker;
  /** The tracker's first entry, so paging can stop at the start of history. */
  earliest?: string | undefined;
  /** Bump to re-fetch after a log/edit elsewhere on the page. */
  refreshKey: number;
}

/**
 * A tracker's entries totalled per period — one row per day/week/month/year,
 * newest first. This is the primary reading of a tracker that resets: what it
 * added up to in each window, how that compares to the window before, and how
 * it sat against the target.
 *
 * A snapshot tracker gets the same table read as levels instead of amounts:
 * the period's closing reading, the spread it moved through (counting the
 * level it opened at — see `snapshotSpan`), and how many readings there were.
 */
export function PeriodTable({ tracker, earliest, refreshKey }: PeriodTableProps) {
  const core = useCore();
  const isSnapshot = tracker.is_snapshot === 1;
  const [period, setPeriod] = useState<BucketPeriod>(
    periodForReset(tracker.reset_period),
  );
  const [shown, setShown] = useState(PAGE_SIZE);
  // Periods with nothing in them are the common case for anything logged less
  // than daily, and a screen of em dashes buries the rows that say something —
  // so the table opens filtered, and unticking brings the gaps back.
  const [hideEmpty, setHideEmpty] = useState(true);

  // One extra, older bucket is fetched but never rendered: it supplies the
  // oldest visible row's "vs previous period" comparison.
  const { data, loading, error } = useAsync(async () => {
    const range = lastNBuckets(period, shown + 1, tracker);
    return core.stats.bucket(tracker.id, range, period);
  }, [
    tracker.id,
    tracker.week_start,
    tracker.day_start_minute,
    tracker.month_start_day,
    tracker.year_start_month,
    period,
    shown,
    refreshKey,
  ]);

  // Newest first, each row carrying the delta against the period before it.
  const rows = useMemo(() => {
    const buckets = data ?? [];
    return buckets
      .map((bucket, i) => ({
        bucket,
        previous: i > 0 ? buckets[i - 1]! : null,
      }))
      .reverse()
      .slice(0, shown);
  }, [data, shown]);

  // Each row carries the move it made and the span of levels it covers, which
  // the columns and the footer both read — so the two can never disagree about
  // how far back a period reaches.
  const visible = (hideEmpty ? rows.filter((r) => r.bucket.count > 0) : rows).map(
    (row) => ({
      ...row,
      span: isSnapshot ? snapshotSpan(row.bucket, row.previous, earliest) : null,
      change: periodChange(row.bucket, row.previous, isSnapshot, earliest),
    }),
  );
  // The footer describes what's on screen, so hiding the empty periods
  // narrows it too rather than leaving it quoting rows the user can't see.
  const totals = summarize(visible);

  // A target is per *reset* window ("8 glasses a day"), so it only means
  // anything on the matching period: a week's total against a daily target
  // would read as 350%.
  const showTarget =
    !isSnapshot &&
    tracker.target != null &&
    tracker.reset_period !== 'never' &&
    period === periodForReset(tracker.reset_period);

  // Paging stops once the fetched range reaches back past the first entry —
  // there is no more history to walk into. With nothing logged (or no known
  // first entry) there is nothing to page toward at all.
  const oldestFetched = data?.[0]?.start;
  const moreToShow =
    earliest !== undefined &&
    oldestFetched !== undefined &&
    new Date(oldestFetched).getTime() > new Date(earliest).getTime();

  return (
    <div className="periods">
      <div className="periods__head">
        <div className="periods__periods" role="group" aria-label="Table period">
          {PERIODS.map((p) => (
            <button
              key={p.period}
              type="button"
              className={`btn btn--small${p.period === period ? ' btn--active' : ''}`}
              aria-pressed={p.period === period}
              onClick={() => {
                setPeriod(p.period);
                setShown(PAGE_SIZE);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="periods__toggle">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
          />
          <span>Hide empty periods</span>
        </label>
      </div>

      {error && <p className="error">{error.message}</p>}
      {loading && !data && <p className="muted">Loading periods…</p>}

      {data &&
        (visible.length === 0 ? (
          <p className="muted">
            {rows.length === 0
              ? 'Nothing logged yet.'
              : 'Nothing logged in these periods.'}
          </p>
        ) : (
          <>
            <div className="periods__scroll">
              <table className="periods__table">
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col" className="periods__num">
                      {isSnapshot ? 'Latest' : 'Total'}
                    </th>
                    {isSnapshot && (
                      <th scope="col" className="periods__num">
                        Range
                      </th>
                    )}
                    <th scope="col" className="periods__num">
                      {isSnapshot ? 'Change' : 'vs prev'}
                    </th>
                    <th scope="col" className="periods__num">
                      {isSnapshot ? 'Readings' : 'Entries'}
                    </th>
                    {showTarget && (
                      <th scope="col" className="periods__num">
                        of {formatNumber(tracker.target!, tracker.unit)}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ bucket, span, change }) => (
                    <tr
                      key={bucket.label}
                      className={bucket.count === 0 ? 'periods__row--empty' : undefined}
                    >
                      <th scope="row">
                        {periodRowLabel(bucket.start, period, tracker)}
                      </th>
                      <td className="periods__num" style={{ color: tracker.color }}>
                        {hasValue(bucket, isSnapshot, earliest)
                          ? formatValue(tracker, bucket.value)
                          : '—'}
                      </td>
                      {isSnapshot && (
                        <td className="periods__num">
                          {span
                            ? `${formatValue(tracker, span.lo)}–${formatValue(tracker, span.hi)}`
                            : '—'}
                        </td>
                      )}
                      <td className="periods__num">
                        <Delta tracker={tracker} change={change} />
                      </td>
                      <td className="periods__num">{bucket.count}</td>
                      {showTarget && (
                        <td className="periods__num">
                          {bucket.count === 0
                            ? '—'
                            : `${Math.round((bucket.value / tracker.target!) * 100)}%`}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">
                      {visible.length} {period}
                      {visible.length === 1 ? '' : 's'}
                    </th>
                    <td className="periods__num">
                      {isSnapshot ? '' : formatValue(tracker, totals.total)}
                    </td>
                    {isSnapshot && (
                      <td className="periods__num">
                        {totals.spanned > 0
                          ? `${formatValue(tracker, totals.min)}–${formatValue(tracker, totals.max)}`
                          : '—'}
                      </td>
                    )}
                    <td className="periods__num">
                      {isSnapshot ? (
                        // The visible rows' moves add up to the net move across
                        // them, each row reaching back to where it opened.
                        <Delta tracker={tracker} change={totals.change} />
                      ) : totals.logged > 0 ? (
                        `avg ${formatValue(tracker, totals.total / totals.logged)}`
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="periods__num">{totals.count}</td>
                    {showTarget && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* The averages describe only the periods that saw activity —
                otherwise a tracker's mean would sag toward zero with every
                empty period the table happens to reach back over. */}
            <p className="muted periods__note">
              {isSnapshot
                ? 'Levels don’t add up: each period shows its closing reading, and the range it covered since the period before.'
                : `Averaged over the ${totals.logged} period${
                    totals.logged === 1 ? '' : 's'
                  } with entries.`}
            </p>

            {moreToShow && (
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setShown((n) => n + PAGE_SIZE)}
              >
                Show more
              </button>
            )}
          </>
        ))}
    </div>
  );
}

/**
 * Whether a bucket has a value worth printing, as opposed to an em dash.
 *
 * A sum tracker's empty period is simply blank. A snapshot tracker's is
 * usually *not*: a level persists, so a period with no reading still shows
 * the last known one. The exception is a period that predates the first
 * reading ever — there the zero the server reports means "no level yet", and
 * printing it would claim the user weighed nothing that week.
 */
function hasValue(
  bucket: StatBucket,
  isSnapshot: boolean,
  earliest: string | undefined,
): boolean {
  if (bucket.count > 0) return true;
  if (!isSnapshot) return false;
  return (
    earliest !== undefined &&
    new Date(bucket.start).getTime() >= new Date(earliest).getTime()
  );
}

/**
 * The span of levels a snapshot period covers — its own readings, plus the
 * level it opened at.
 *
 * A level carries over, so a period doesn't begin at its own first reading: it
 * begins wherever the period before it closed, and the move from that closing
 * level to the first reading belongs to this period. Spanning the readings
 * alone drops that move, and the rows then read as if the level teleported
 * between periods — each range starting somewhere other than where the range
 * above it ended. The oldest period on record has nothing behind it to open
 * from, so it spans only what it saw.
 *
 * Null when there is no span to draw: a period with no readings (its level is
 * simply the one carried in), or one whose level never moved off the value it
 * opened at.
 */
function snapshotSpan(
  bucket: StatBucket,
  previous: StatBucket | null,
  earliest: string | undefined,
): { lo: number; hi: number } | null {
  if (bucket.count === 0) return null;
  let lo = bucket.min;
  let hi = bucket.max;
  // The bucket before is only an opening level if it actually holds one —
  // before the first reading ever, its zero means "no level yet".
  if (previous !== null && hasValue(previous, true, earliest)) {
    lo = Math.min(lo, previous.value);
    hi = Math.max(hi, previous.value);
  }
  return lo === hi ? null : { lo, hi };
}

/**
 * The move from the period before — a difference of totals for a tracker that
 * sums, and of closing levels for one that snapshots. A snapshot's move is the
 * one figure the table was missing: with levels, what the period *did* is the
 * distance travelled, not the reading it happened to stop at.
 *
 * Null when there is nothing to subtract: the oldest row's predecessor may
 * simply be outside what was fetched, and a level that doesn't exist yet
 * (before the first reading ever) is not a level of zero to fall from.
 */
function periodChange(
  bucket: StatBucket,
  previous: StatBucket | null,
  isSnapshot: boolean,
  earliest: string | undefined,
): number | null {
  if (previous === null) return null;
  if (
    isSnapshot &&
    !(hasValue(bucket, true, earliest) && hasValue(previous, true, earliest))
  ) {
    return null;
  }
  return bucket.value - previous.value;
}

/** A change against what came before, as an arrow and a magnitude. */
function Delta({ tracker, change }: { tracker: Tracker; change: number | null }) {
  if (change === null) return <span className="muted">—</span>;
  if (change === 0) return <span className="muted">±0</span>;
  return (
    <span className={change > 0 ? 'periods__up' : 'periods__down'}>
      {change > 0 ? '▲' : '▼'} {formatValue(tracker, Math.abs(change))}
    </span>
  );
}

/**
 * Footer figures over the visible periods. `logged` counts the periods that
 * saw at least one entry, ignoring empty ones, which carry no reading of their
 * own. `min`/`max` are the union of the rows' own spans over `spanned` of
 * them, so the footer covers exactly the levels the rows above it name — no
 * wider, and never narrower than a range on screen. `change` adds up the same
 * rows' moves, which telescopes into the net move across them.
 */
function summarize(
  rows: readonly {
    bucket: StatBucket;
    span: { lo: number; hi: number } | null;
    change: number | null;
  }[],
) {
  let total = 0;
  let count = 0;
  let logged = 0;
  let spanned = 0;
  let min = 0;
  let max = 0;
  let change: number | null = null;
  for (const { bucket, span, change: moved } of rows) {
    total += bucket.value;
    count += bucket.count;
    if (bucket.count > 0) logged += 1;
    if (moved !== null) change = (change ?? 0) + moved;
    if (span === null) continue;
    if (spanned === 0 || span.lo < min) min = span.lo;
    if (spanned === 0 || span.hi > max) max = span.hi;
    spanned += 1;
  }
  return { total, count, logged, spanned, min, max, change };
}
