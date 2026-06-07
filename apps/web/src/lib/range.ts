import {
  toLocalISO,
  bucketStart,
  bucketEnd,
  type TimeRange,
  type BucketPeriod,
  type ResetPeriod,
  type WeekStart,
} from '@countroster/core';

/**
 * The [start, end) ISO range covering the local calendar day that contains
 * `now`. Used for "today's total" on the home screen.
 *
 * Bounds are formatted with `toLocalISO` (local offset, never UTC "Z"). The
 * core compares them against stored `occurred_at` by absolute instant (via
 * SQLite `julianday`, which parses the offset), so a range expressed in this
 * device's timezone is correct even when the server logged entries in a
 * different one — see `EntryService.forTracker`.
 *
 * NOTE: This is calendar-local midnight, matching the baseline bucketing in
 * core's periods.ts. It does not yet honor per-tracker `day_start_minute` —
 * that logic belongs in core when it lands (see DESIGN Appendix B), and this
 * helper should defer to it rather than reimplementing it.
 */
export function todayRange(now: Date = new Date()): Required<TimeRange> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: toLocalISO(start), end: toLocalISO(end) };
}

/** Sum the `value` field across rows. */
export function sumValues(rows: readonly { value: number }[]): number {
  return rows.reduce((acc, r) => acc + r.value, 0);
}

/** Map a tracker's `reset_period` to the bucketing period it corresponds to. */
const RESET_TO_BUCKET: Record<Exclude<ResetPeriod, 'never'>, BucketPeriod> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

/** Short label for the window a tracker's total covers, e.g. "this week". */
export const RESET_PERIOD_LABEL: Record<ResetPeriod, string> = {
  never: 'all time',
  daily: 'today',
  weekly: 'this week',
  monthly: 'this month',
  yearly: 'this year',
};

/**
 * The [start, end) range covering the *current* reset period for a tracker —
 * the window whose total the home card should show (à la Tally's "resets
 * every…"). Returns `null` for `'never'`, meaning "no window: all-time total".
 *
 * Boundaries are aligned with core's bucketing (honoring `weekStart`) and
 * formatted with the local offset; the core compares them by instant.
 */
export function resetPeriodRange(
  resetPeriod: ResetPeriod,
  weekStart: WeekStart = 1,
  now: Date = new Date(),
): Required<TimeRange> | null {
  if (resetPeriod === 'never') return null;
  const period = RESET_TO_BUCKET[resetPeriod];
  return {
    start: toLocalISO(bucketStart(now, period, weekStart)),
    end: toLocalISO(bucketEnd(now, period, weekStart)),
  };
}

/**
 * The [start, end) ISO range covering the most recent `count` buckets of the
 * given `period`, up to and including the in-progress one. Boundaries are
 * aligned to the same `weekStart` the core uses so the server's buckets line
 * up exactly with what we requested.
 */
export function lastNBuckets(
  period: BucketPeriod,
  count: number,
  weekStart: 0 | 1 = 1,
  now: Date = new Date(),
): Required<TimeRange> {
  const end = bucketEnd(now, period, weekStart);
  let start = bucketStart(now, period, weekStart);
  for (let i = 1; i < count; i++) {
    // Step into the previous bucket, then normalize to its start.
    start = bucketStart(new Date(start.getTime() - 1), period, weekStart);
  }
  return { start: toLocalISO(start), end: toLocalISO(end) };
}
