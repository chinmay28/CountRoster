/**
 * Period bucketing helpers.
 *
 * NOTE: This is the simple-but-correct baseline. It uses local-time math via
 * the JS Date API, which means it respects the host's timezone but doesn't
 * yet honor a tracker-specific timezone or `day_start_minute`.
 *
 * Honoring `day_start_minute` and arbitrary tracker timezones is on the
 * roadmap; when added, this module is where it goes.
 */

export type BucketPeriod = 'day' | 'week' | 'month' | 'year';

export interface Bucket {
  /** Inclusive lower bound, ISO 8601 local time. */
  start: string;
  /** Exclusive upper bound, ISO 8601 local time. */
  end: string;
  /** Stable identifier, e.g. "2026-W21" for weeks, "2026-05" for months. */
  label: string;
}

/**
 * Start of the bucket containing `instant`.
 * `weekStart`: 0 = Sunday, 1 = Monday. Only relevant for `period === 'week'`.
 */
export function bucketStart(
  instant: Date,
  period: BucketPeriod,
  weekStart: 0 | 1 = 1,
): Date {
  const d = new Date(instant);
  d.setHours(0, 0, 0, 0);

  switch (period) {
    case 'day':
      return d;
    case 'week': {
      const dow = d.getDay(); // 0 = Sunday ... 6 = Saturday
      const diff = (dow - weekStart + 7) % 7;
      d.setDate(d.getDate() - diff);
      return d;
    }
    case 'month':
      d.setDate(1);
      return d;
    case 'year':
      d.setMonth(0, 1);
      return d;
  }
}

/** Start of the next bucket after the one containing `instant`. */
export function bucketEnd(
  instant: Date,
  period: BucketPeriod,
  weekStart: 0 | 1 = 1,
): Date {
  const start = bucketStart(instant, period, weekStart);
  const end = new Date(start);
  switch (period) {
    case 'day':
      end.setDate(end.getDate() + 1);
      return end;
    case 'week':
      end.setDate(end.getDate() + 7);
      return end;
    case 'month':
      end.setMonth(end.getMonth() + 1);
      return end;
    case 'year':
      end.setFullYear(end.getFullYear() + 1);
      return end;
  }
}

export function bucketLabel(start: Date, period: BucketPeriod): string {
  const yyyy = start.getFullYear();
  const mm = String(start.getMonth() + 1).padStart(2, '0');
  const dd = String(start.getDate()).padStart(2, '0');
  switch (period) {
    case 'day':
      return `${yyyy}-${mm}-${dd}`;
    case 'week':
      return `${yyyy}-W${String(isoWeekNumber(start)).padStart(2, '0')}`;
    case 'month':
      return `${yyyy}-${mm}`;
    case 'year':
      return String(yyyy);
  }
}

/** ISO 8601 week number (1..53). Used only for labelling. */
function isoWeekNumber(date: Date): number {
  // Copy and shift to Thursday of the same week (ISO weeks are anchored on Thursday).
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return weekNo;
}
