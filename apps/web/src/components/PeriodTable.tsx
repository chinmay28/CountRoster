import { useMemo, useState } from 'react';
import type { BucketPeriod, ResetPeriod, StatBucket, Tracker } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue, formatNumber } from '../lib/format.ts';
import { lastNBuckets, periodRowLabel } from '../lib/range.ts';

/** Period toggle, coarsest resolution last. */
const PERIODS: { period: BucketPeriod; label: string }[] = [
  { period: 'day', label: 'Day' },
  { period: 'week', label: 'Week' },
  { period: 'month', label: 'Month' },
  { period: 'year', label: 'Year' },
];

/** The period a tracker resets on — the breakdown it's really about. */
const RESET_TO_PERIOD: Record<ResetPeriod, BucketPeriod> = {
  never: 'month',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

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
 * the period's closing reading, the spread it moved through, and how many
 * readings there were.
 */
export function PeriodTable({ tracker, earliest, refreshKey }: PeriodTableProps) {
  const core = useCore();
  const isSnapshot = tracker.is_snapshot === 1;
  const [period, setPeriod] = useState<BucketPeriod>(
    RESET_TO_PERIOD[tracker.reset_period],
  );
  const [shown, setShown] = useState(PAGE_SIZE);
  const [hideEmpty, setHideEmpty] = useState(false);

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

  const visible = hideEmpty ? rows.filter((r) => r.bucket.count > 0) : rows;
  // The footer describes what's on screen, so hiding the empty periods
  // narrows it too rather than leaving it quoting rows the user can't see.
  const totals = summarize(visible.map((r) => r.bucket));

  // A target is per *reset* window ("8 glasses a day"), so it only means
  // anything on the matching period: a week's total against a daily target
  // would read as 350%.
  const showTarget =
    !isSnapshot &&
    tracker.target != null &&
    tracker.reset_period !== 'never' &&
    period === RESET_TO_PERIOD[tracker.reset_period];

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
                    <th scope="col" className="periods__num">
                      {isSnapshot ? 'Range' : 'Entries'}
                    </th>
                    <th scope="col" className="periods__num">
                      {isSnapshot ? 'Readings' : 'vs prev'}
                    </th>
                    {showTarget && (
                      <th scope="col" className="periods__num">
                        of {formatNumber(tracker.target!, tracker.unit)}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ bucket, previous }) => (
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
                      <td className="periods__num">
                        {isSnapshot
                          ? bucket.count > 1
                            ? `${formatValue(tracker, bucket.min)}–${formatValue(tracker, bucket.max)}`
                            : '—'
                          : bucket.count}
                      </td>
                      <td className="periods__num">
                        {isSnapshot ? (
                          bucket.count
                        ) : (
                          <Delta tracker={tracker} bucket={bucket} previous={previous} />
                        )}
                      </td>
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
                    <td className="periods__num">
                      {isSnapshot
                        ? totals.logged > 0
                          ? `${formatValue(tracker, totals.min)}–${formatValue(tracker, totals.max)}`
                          : '—'
                        : totals.count}
                    </td>
                    <td className="periods__num">
                      {isSnapshot
                        ? totals.count
                        : totals.logged > 0
                          ? `avg ${formatValue(tracker, totals.total / totals.logged)}`
                          : '—'}
                    </td>
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
                ? 'Levels don’t add up: each period shows its closing reading.'
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

/** The change against the period before, as an arrow and a magnitude. */
function Delta({
  tracker,
  bucket,
  previous,
}: {
  tracker: Tracker;
  bucket: StatBucket;
  previous: StatBucket | null;
}) {
  // The oldest row has nothing behind it to compare against — the bucket
  // before it may simply be outside what was fetched.
  if (previous === null) return <span className="muted">—</span>;
  const delta = bucket.value - previous.value;
  if (delta === 0) return <span className="muted">±0</span>;
  return (
    <span className={delta > 0 ? 'periods__up' : 'periods__down'}>
      {delta > 0 ? '▲' : '▼'} {formatValue(tracker, Math.abs(delta))}
    </span>
  );
}

/**
 * Footer figures over the visible periods. `logged` counts the periods that
 * saw at least one entry, and `min`/`max` span the individual entry values in
 * them — both ignore empty periods, which carry no reading of their own.
 */
function summarize(buckets: readonly StatBucket[]) {
  let total = 0;
  let count = 0;
  let logged = 0;
  let min = 0;
  let max = 0;
  for (const b of buckets) {
    total += b.value;
    count += b.count;
    if (b.count === 0) continue;
    if (logged === 0 || b.min < min) min = b.min;
    if (logged === 0 || b.max > max) max = b.max;
    logged += 1;
  }
  return { total, count, logged, min, max };
}
