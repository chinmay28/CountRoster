import { describe, it, expect } from 'vitest';
import type { Tracker } from '@countroster/core';
import {
  formatDuration,
  formatNumber,
  formatValue,
  formatRelativeTime,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  ordinal,
  minuteToTimeInput,
  timeInputFromValue,
  describePeriodWindow,
} from './format.ts';

function makeTracker(patch: Partial<Tracker>): Tracker {
  return {
    id: 't1',
    name: 'T',
    description: null,
    color: '#888888',
    icon: null,
    kind: 'count',
    unit: null,
    target: null,
    reset_period: 'never',
    week_start: 1,
    day_start_minute: 0,
    month_start_day: 1,
    year_start_month: 1,
    default_value: 1,
    archived_at: null,
    sort_order: 0,
    is_derived: 0,
    is_hidden: 0,
    is_snapshot: 0,
    section_order: null,
    created_at: '2026-05-25T12:00:00.000-07:00',
    updated_at: '2026-05-25T12:00:00.000-07:00',
    ...patch,
  };
}

describe('formatDuration', () => {
  it('formats h/m/s and drops empty parts', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(63)).toBe('1m 3s');
    expect(formatDuration(3661)).toBe('1h 1m 1s');
    expect(formatDuration(3600)).toBe('1h');
  });
});

describe('formatNumber', () => {
  it('omits trailing .0 and appends a unit', () => {
    expect(formatNumber(5)).toBe('5');
    expect(formatNumber(2.5, 'cups')).toBe('2.5 cups');
  });

  it('writes currency units as a prefix without a space', () => {
    expect(formatNumber(5, '$')).toBe('$5');
    expect(formatNumber(12.5, '€')).toBe('€12.5');
    expect(formatNumber(3, '£')).toBe('£3');
    // The sign stays ahead of the symbol.
    expect(formatNumber(-5, '$')).toBe('-$5');
  });

  it('groups thousands for currency, so large amounts stay readable', () => {
    expect(formatNumber(1981284, '$')).toBe('$1,981,284');
    expect(formatNumber(403612.5, '$')).toBe('$403,612.5');
    expect(formatNumber(-55000, '$')).toBe('-$55,000');
    // Only money gets separators; plain counts keep the bare digits.
    expect(formatNumber(1234567)).toBe('1234567');
    expect(formatNumber(1234567, 'steps')).toBe('1234567 steps');
  });
});

describe('formatValue', () => {
  it('renders by tracker kind', () => {
    expect(formatValue(makeTracker({ kind: 'duration' }), 90)).toBe('1m 30s');
    expect(formatValue(makeTracker({ kind: 'boolean' }), 1)).toBe('Yes');
    expect(formatValue(makeTracker({ kind: 'boolean' }), 0)).toBe('No');
    expect(formatValue(makeTracker({ kind: 'number', unit: 'mg' }), 200)).toBe(
      '200 mg',
    );
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-25T12:00:00-07:00');
  const ago = (minutes: number) =>
    formatRelativeTime(
      new Date(now.getTime() - minutes * 60_000).toISOString(),
      now,
    );

  it('counts down through minutes, hours, and days', () => {
    expect(ago(0)).toBe('just now');
    expect(ago(12)).toBe('12m ago');
    expect(ago(60 * 3)).toBe('3h ago');
    expect(ago(60 * 24)).toBe('Yesterday');
    expect(ago(60 * 24 * 3)).toBe('3d ago');
  });

  it('falls back to a date once it is a week out', () => {
    expect(ago(60 * 24 * 9)).toBe('May 16, 2026');
  });

  it('reads a forward-dated entry as just now rather than a negative age', () => {
    expect(ago(-30)).toBe('just now');
  });
});

describe('datetime-local round trip', () => {
  it('produces a local-offset ISO that re-parses to the same wall time', () => {
    const local = '2026-05-25T14:32';
    const iso = fromDatetimeLocalValue(local);
    // Local-offset ISO, never UTC "Z".
    expect(iso).not.toMatch(/Z$/);
    expect(toDatetimeLocalValue(iso)).toBe(local);
  });
});

describe('period window formatting', () => {
  it('renders ordinals for days of the month', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 28].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '28th',
    ]);
  });

  it('round-trips a day-start minute through a time input value', () => {
    expect(minuteToTimeInput(0)).toBe('00:00');
    expect(minuteToTimeInput(7 * 60)).toBe('07:00');
    expect(minuteToTimeInput(1439)).toBe('23:59');
    expect(timeInputFromValue('07:00')).toBe(420);
    expect(timeInputFromValue('')).toBe(0);
  });

  it('summarizes only the windows that leave the calendar', () => {
    const calendar = {
      day_start_minute: 0,
      week_start: 1 as const,
      month_start_day: 1,
      year_start_month: 1,
    };
    expect(describePeriodWindow(calendar)).toBe(
      'Calendar days, weeks, months and years',
    );
    const summary = describePeriodWindow({
      ...calendar,
      day_start_minute: 7 * 60,
      week_start: 0,
      month_start_day: 8,
      year_start_month: 4,
    });
    // The day window closes one minute before it reopens.
    expect(summary).toContain('6:59');
    expect(summary).toContain('Weeks from Sunday');
    expect(summary).toContain('Months from the 8th');
    expect(summary).toContain('Years from April');
  });
});
