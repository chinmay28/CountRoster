import { toLocalISO, type TimeRange } from '@countroster/core';

/**
 * The [start, end) ISO range covering the local calendar day that contains
 * `now`. Used for "today's total" on the home screen.
 *
 * Bounds are formatted with `toLocalISO` (local offset, never UTC "Z") so
 * they compare correctly as strings against the timestamps the core stores —
 * core persists `occurred_at` in local-offset ISO, and the SQL range filter
 * is a lexical TEXT comparison.
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
