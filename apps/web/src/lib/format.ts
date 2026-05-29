import type { Tracker, TrackerKind } from '@countroster/core';

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

/** Format a number without trailing zeros, with a unit if present. */
export function formatNumber(value: number, unit?: string | null): string {
  // Round to 2 decimals but drop trailing zeros (2.5 not 2.50, 3 not 3.00).
  const n = String(Math.round(value * 100) / 100);
  return unit ? `${n} ${unit}` : n;
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
