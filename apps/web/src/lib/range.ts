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

/** A row that carries a value and the instant it occurred. */
type ValuedEntry = { value: number; occurred_at: string };

/** Sum the values of entries whose `occurred_at` falls in `[start, end)`. */
export function sumInRange(
  entries: readonly ValuedEntry[],
  range: { start: string; end: string },
): number {
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();
  return sumValues(
    entries.filter((e) => {
      const t = new Date(e.occurred_at).getTime();
      return t >= start && t < end;
    }),
  );
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
  return currentPeriodRange(RESET_TO_BUCKET[resetPeriod], weekStart, now);
}

/**
 * The [start, end) range covering the *current* bucket of the given period
 * (this week / month / year …), aligned to the same `weekStart` the core uses
 * and formatted with the local offset.
 */
export function currentPeriodRange(
  period: BucketPeriod,
  weekStart: WeekStart = 1,
  now: Date = new Date(),
): Required<TimeRange> {
  return {
    start: toLocalISO(bucketStart(now, period, weekStart)),
    end: toLocalISO(bucketEnd(now, period, weekStart)),
  };
}

/** One windowed total in the summary breakdown. */
export interface WindowStat {
  /** Stable key: a `BucketPeriod`, `'all-time'`, or a snapshot extremum. */
  key: BucketPeriod | 'all-time' | 'all-time-high' | 'all-time-low';
  /** Human label, e.g. "this week". */
  label: string;
  value: number;
}

/** The standard windows, narrowest → broadest, that precede all-time. */
const STAT_WINDOWS: { key: BucketPeriod; label: string }[] = [
  { key: 'week', label: 'this week' },
  { key: 'month', label: 'this month' },
  { key: 'year', label: 'this year' },
];

/**
 * Break a tracker's total down across the standard windows — this week, this
 * month, this year, all-time — independent of its reset period.
 *
 * Adjacent windows holding the same total are collapsed: a narrower window is
 * dropped when it equals the next broader one, since it adds no information
 * (e.g. zero this month implies zero this week). All-time is always kept, so
 * at minimum a single all-time figure is returned.
 */
export function windowStats(
  entries: readonly ValuedEntry[],
  weekStart: WeekStart = 1,
  now: Date = new Date(),
): WindowStat[] {
  const ordered: WindowStat[] = [
    ...STAT_WINDOWS.map(({ key, label }) => ({
      key,
      label,
      value: sumInRange(entries, currentPeriodRange(key, weekStart, now)),
    })),
    { key: 'all-time' as const, label: 'all-time', value: sumValues(entries) },
  ];
  return ordered.filter((stat, i) => {
    const broader = ordered[i + 1];
    return broader === undefined || stat.value !== broader.value;
  });
}

/**
 * The current value of a snapshot tracker: its most recent reading. Entries
 * arrive from the core ordered by occurred_at ascending, so that's the last
 * one. Returns 0 when nothing has been logged yet.
 */
export function latestValue(entries: readonly ValuedEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]!.value : 0;
}

/**
 * The summary breakdown for a snapshot tracker: instead of windowed totals
 * (which don't apply to point-in-time levels), report the all-time high and
 * all-time low readings. Empty when nothing has been logged.
 */
export function snapshotStats(entries: readonly ValuedEntry[]): WindowStat[] {
  if (entries.length === 0) return [];
  let min = entries[0]!.value;
  let max = entries[0]!.value;
  for (const e of entries) {
    if (e.value < min) min = e.value;
    if (e.value > max) max = e.value;
  }
  return [
    { key: 'all-time-high', label: 'all-time high', value: max },
    { key: 'all-time-low', label: 'all-time low', value: min },
  ];
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
