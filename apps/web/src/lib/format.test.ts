import { describe, it, expect } from 'vitest';
import type { Tracker } from '@countroster/core';
import {
  formatDuration,
  formatNumber,
  formatValue,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
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
    default_value: 1,
    archived_at: null,
    sort_order: 0,
    is_derived: 0,
    is_hidden: 0,
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

describe('datetime-local round trip', () => {
  it('produces a local-offset ISO that re-parses to the same wall time', () => {
    const local = '2026-05-25T14:32';
    const iso = fromDatetimeLocalValue(local);
    // Local-offset ISO, never UTC "Z".
    expect(iso).not.toMatch(/Z$/);
    expect(toDatetimeLocalValue(iso)).toBe(local);
  });
});
