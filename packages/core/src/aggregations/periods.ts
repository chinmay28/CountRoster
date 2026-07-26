/**
 * Period bucketing helpers.
 *
 * This is local-time math via the JS Date API: it respects the host's
 * timezone and honors the tracker's custom period window (`PeriodWindow`),
 * but doesn't yet support a tracker-specific timezone. When that lands, this
 * module is where it goes.
 */

import type { WeekStart } from '../schema/tables.js';

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
 * Where a tracker's periods begin. The field names match the tracker columns
 * they come from, so a `Tracker` can be passed straight in; every field is
 * optional and falls back to plain calendar bucketing.
 */
export interface PeriodWindow {
  /**
   * Minutes after local midnight a day begins: 420 runs a day 7:00 AM → 6:59
   * AM. Shifts every period, since all of them start on a day.
   */
  day_start_minute?: number;
  /** Weekday a week begins on: 0 = Sunday, 1 = Monday. */
  week_start?: WeekStart;
  /**
   * Day-of-month a month begins on, 1..28: 8 runs a month the 8th → the 7th
   * of the next month. Also the day a year begins on.
   */
  month_start_day?: number;
  /** Month a year begins on, 1..12: 4 runs a year April → March. */
  year_start_month?: number;
}

interface ResolvedWindow {
  dayStartMinute: number;
  weekStart: WeekStart;
  monthStartDay: number;
  yearStartMonth: number;
}

/** Fill in the calendar defaults and drop out-of-range components. */
function resolve(window: PeriodWindow): ResolvedWindow {
  const inRange = (v: number | undefined, min: number, max: number, fallback: number): number =>
    v !== undefined && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return {
    dayStartMinute: inRange(window.day_start_minute, 0, 1439, 0),
    weekStart: (inRange(window.week_start, 0, 1, 1) as WeekStart),
    monthStartDay: inRange(window.month_start_day, 1, 28, 1),
    yearStartMonth: inRange(window.year_start_month, 1, 12, 1),
  };
}

/**
 * Start of the *logical* day containing `instant` — local midnight plus the
 * window's day start, stepping back a calendar day for an instant that falls
 * before the day has opened (03:30 with a 7:00 AM day start still belongs to
 * the previous day).
 */
function dayStartOf(instant: Date, w: ResolvedWindow): Date {
  const d = new Date(instant);
  d.setHours(0, w.dayStartMinute, 0, 0);
  if (instant.getHours() * 60 + instant.getMinutes() < w.dayStartMinute) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/** Start of the bucket containing `instant`. */
export function bucketStart(
  instant: Date,
  period: BucketPeriod,
  window: PeriodWindow = {},
): Date {
  const w = resolve(window);
  // Every period opens at a day boundary, so start from the logical day and
  // walk back to the period's first day.
  const d = dayStartOf(instant, w);

  switch (period) {
    case 'day':
      return d;
    case 'week': {
      const dow = d.getDay(); // 0 = Sunday ... 6 = Saturday
      const diff = (dow - w.weekStart + 7) % 7;
      d.setDate(d.getDate() - diff);
      return d;
    }
    case 'month': {
      // Before this month's opening day, we're still in the window that opened
      // last month; setMonth normalizes month -1 to last December.
      if (d.getDate() < w.monthStartDay) d.setMonth(d.getMonth() - 1, 1);
      d.setDate(w.monthStartDay);
      return d;
    }
    case 'year': {
      const start = new Date(d);
      start.setMonth(w.yearStartMonth - 1, w.monthStartDay);
      if (d < start) start.setFullYear(start.getFullYear() - 1);
      return start;
    }
  }
}

/** Start of the next bucket after the one containing `instant`. */
export function bucketEnd(
  instant: Date,
  period: BucketPeriod,
  window: PeriodWindow = {},
): Date {
  const start = bucketStart(instant, period, window);
  const end = new Date(start);
  switch (period) {
    case 'day':
      end.setDate(end.getDate() + 1);
      return end;
    case 'week':
      end.setDate(end.getDate() + 7);
      return end;
    case 'month':
      // The date is month_start_day (<= 28), so the next month always has it.
      end.setMonth(end.getMonth() + 1);
      return end;
    case 'year':
      end.setFullYear(end.getFullYear() + 1);
      return end;
  }
}

/**
 * Stable identifier for a bucket starting at `start`. With a custom window the
 * label names the calendar date/month/year the bucket *opens* in: a month
 * window running May 8 → June 7 is labelled "2026-05".
 */
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
