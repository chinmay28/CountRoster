import { toLocalISO, bucketStart, bucketEnd, type TimeRange, type BucketPeriod } from '@countroster/core';

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
