import type {
  BucketPeriod,
  ResetPeriod,
  Tracker,
  TrackerKind,
  WeekStart,
} from '@countroster/core';

/** Human label for each tracker kind. */
export const KIND_LABELS: Record<TrackerKind, string> = {
  count: 'Count',
  number: 'Number',
  duration: 'Duration',
  boolean: 'Yes / No',
  choice: 'Choice',
};

export const TRACKER_KINDS: readonly TrackerKind[] = [
  'count',
  'number',
  'duration',
  'boolean',
  'choice',
];

/**
 * The tracker form's "Reset every" choice: a real reset period, or
 * `'snapshot'` — the tracker records point-in-time levels (net worth,
 * weight), so resetting doesn't apply. `'snapshot'` maps to
 * `{ reset_period: 'never', is_snapshot: 1 }` on the wire.
 */
export type ResetChoice = ResetPeriod | 'snapshot';

/** "Reset every" choices for the tracker form, in menu order. */
export const RESET_PERIOD_OPTIONS: readonly { value: ResetChoice; label: string }[] = [
  { value: 'never', label: 'Never (cumulative)' },
  { value: 'daily', label: 'Day' },
  { value: 'weekly', label: 'Week' },
  { value: 'monthly', label: 'Month' },
  { value: 'yearly', label: 'Year' },
  { value: 'snapshot', label: 'Not applicable — snapshot stat' },
];

/**
 * The tracker form's period-window controls. A tracker's periods need not
 * line up with the calendar: a day can run 7:00 AM → 6:59 AM, a month the 8th
 * → the 7th, a year April → March.
 */
export const WEEK_START_OPTIONS: readonly { value: WeekStart; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 0, label: 'Sunday' },
];

export const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Capped at 28 so every month has the day — see migration 006. */
export const MONTH_START_DAYS: readonly number[] = Array.from(
  { length: 28 },
  (_, i) => i + 1,
);

/** English ordinal for a day of the month: 1 → "1st", 22 → "22nd". */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Minutes since midnight as an <input type="time"> value: 420 → "07:00". */
export function minuteToTimeInput(minute: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** An <input type="time"> value back to minutes since midnight; 0 if blank. */
export function timeInputFromValue(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (h === undefined || Number.isNaN(h)) return 0;
  return h * 60 + (Number.isNaN(m ?? NaN) ? 0 : (m ?? 0));
}

/** Clock label for a day-start minute, e.g. 420 → "7:00 AM". */
export function formatClockMinute(minute: number): string {
  const d = new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * One-line summary of a tracker's period windows, e.g. "Days 7:00 AM–6:59 AM ·
 * Weeks from Monday · Months from the 8th · Years from April". Only the parts
 * that differ from the plain calendar are spelled out; an all-default window
 * reads "Calendar days, weeks, months and years".
 */
export function describePeriodWindow(w: {
  day_start_minute: number;
  week_start: WeekStart;
  month_start_day: number;
  year_start_month: number;
}): string {
  const parts: string[] = [];
  if (w.day_start_minute !== 0) {
    const end = (w.day_start_minute + 1439) % 1440;
    parts.push(
      `Days ${formatClockMinute(w.day_start_minute)}–${formatClockMinute(end)}`,
    );
  }
  if (w.week_start !== 1) parts.push('Weeks from Sunday');
  if (w.month_start_day !== 1) {
    parts.push(`Months from the ${ordinal(w.month_start_day)}`);
  }
  if (w.year_start_month !== 1) {
    parts.push(`Years from ${MONTH_NAMES[w.year_start_month - 1]}`);
  }
  return parts.length === 0
    ? 'Calendar days, weeks, months and years'
    : parts.join(' · ');
}

/** Format a duration given in seconds as e.g. "1h 5m 3s". */
export function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  let s = Math.abs(Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return sign + parts.join(' ');
}

/**
 * A currency-style unit (e.g. "$", "€", "£", "¥") is written *before* the
 * number with no space ("$5"), the way money reads, unlike trailing units
 * like "5 cups". Detected via the Unicode Currency_Symbol property.
 */
export function isCurrencyUnit(unit: string): boolean {
  return /^\p{Sc}+$/u.test(unit);
}

/** Format a number without trailing zeros, with a unit if present. */
export function formatNumber(value: number, unit?: string | null): string {
  // Round to 2 decimals but drop trailing zeros (2.5 not 2.50, 3 not 3.00).
  const rounded = Math.round(value * 100) / 100;
  if (!unit) return String(rounded);
  if (isCurrencyUnit(unit)) {
    // Money reads with thousands separators ($1,981,284) and the sign ahead
    // of the symbol: "-$5", not "$-5".
    const n = Math.abs(rounded).toLocaleString('en-US', {
      maximumFractionDigits: 2,
    });
    return rounded < 0 ? `-${unit}${n}` : `${unit}${n}`;
  }
  return `${rounded} ${unit}`;
}

/**
 * Render an aggregated value the way its tracker kind wants to be seen.
 * `value` is typically a sum (count) or the raw recorded number.
 */
export function formatValue(tracker: Tracker, value: number): string {
  switch (tracker.kind) {
    case 'duration':
      return formatDuration(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'count':
    case 'number':
    case 'choice':
      return formatNumber(value, tracker.unit);
  }
}

/** Friendly local datetime, e.g. "May 25, 2026, 2:32 PM". */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * When an entry happened, scaled to the window it is being listed inside.
 * A table covering a single day only needs the clock time; a week needs the
 * weekday to tell rows apart; anything wider needs the date. Keeps every row
 * of one window's table from repeating the same date.
 */
export function formatWithin(iso: string, period: BucketPeriod): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = { hour: 'numeric', minute: '2-digit' } as const;
  switch (period) {
    case 'day':
      return d.toLocaleTimeString(undefined, time);
    case 'week':
      return d.toLocaleString(undefined, { weekday: 'short', ...time });
    case 'month':
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...time });
    case 'year':
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}

/**
 * Compact "how long ago" label for a tight screen: "just now", "12m ago",
 * "3h ago", "Yesterday", then the calendar date once it's a week out.
 * Future instants (a backdated-forward entry) read as "just now".
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

/** Friendly local date only, e.g. "May 25, 2026". */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Convert an ISO timestamp to the value an <input type="datetime-local">
 * expects (local time, no timezone, minute precision).
 */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The local calendar day of `d` as an <input type="date"> value. */
export function toDateInputValue(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Step a date-input value by whole days (negative = back). */
export function shiftDateInputValue(value: string, days: number): string {
  // Anchor at noon so a DST shift inside the step can't slip a day.
  const d = new Date(`${value}T12:00`);
  d.setDate(d.getDate() + days);
  return toDateInputValue(d);
}

/**
 * Friendly label for a date-input value relative to today: "Today",
 * "Yesterday", a near date as "Tue, Jun 9", or a far one with the year.
 */
export function dateInputLabel(value: string, now: Date = new Date()): string {
  if (value === toDateInputValue(now)) return 'Today';
  if (value === shiftDateInputValue(toDateInputValue(now), -1)) return 'Yesterday';
  const d = new Date(`${value}T12:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/**
 * Compact label for a datetime-input value: "Today, 1:15 AM",
 * "Yesterday, 11:40 PM", "Tue, Jun 9, 8:05 AM". Used where a backdated
 * timestamp has to read at a glance on a phone.
 */
export function datetimeInputLabel(value: string, now: Date = new Date()): string {
  const date = value.split('T')[0];
  const at = new Date(value);
  if (!date || Number.isNaN(at.getTime())) return value;
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dateInputLabel(date, now)}, ${clock}`;
}

/**
 * Convert a <input type="datetime-local"> value back to ISO 8601 with the
 * local timezone offset — the format the core stores (never UTC "Z").
 */
export function fromDatetimeLocalValue(local: string): string {
  // `new Date("YYYY-MM-DDTHH:mm")` is interpreted as local time.
  const d = new Date(local);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${offH}:${offM}`
  );
}
