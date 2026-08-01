import { describe, it, expect } from 'vitest';
import type { Tracker } from '@countroster/core';
import { quickMode, readingDelta } from './quick.ts';

function tracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 't1',
    name: 'Test',
    description: null,
    color: '#4ecdc4',
    icon: null,
    kind: 'count',
    unit: null,
    target: null,
    reset_period: 'daily',
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
    ...overrides,
  };
}

describe('quickMode', () => {
  it('gives counts and yes/no trackers the one-tap control', () => {
    expect(quickMode(tracker({ kind: 'count' }))).toBe('tap');
    expect(quickMode(tracker({ kind: 'boolean' }))).toBe('tap');
  });

  it('gives varying amounts the keypad', () => {
    expect(quickMode(tracker({ kind: 'number' }))).toBe('keypad');
    expect(quickMode(tracker({ kind: 'duration' }))).toBe('keypad');
    expect(quickMode(tracker({ kind: 'choice' }))).toBe('keypad');
  });

  it('gives snapshot stats the keypad, whatever their kind', () => {
    expect(quickMode(tracker({ kind: 'number', is_snapshot: 1 }))).toBe('keypad');
    // A level is typed even when the tracker's kind would otherwise tap.
    expect(quickMode(tracker({ kind: 'count', is_snapshot: 1 }))).toBe('keypad');
  });

  it('leaves derived trackers with no control at all', () => {
    expect(quickMode(tracker({ is_derived: 1 }))).toBe('readonly');
    // Derived wins over snapshot: a derived level still can't be logged.
    expect(quickMode(tracker({ is_derived: 1, is_snapshot: 1 }))).toBe('readonly');
  });
});

describe('readingDelta', () => {
  it('rounds to the precision the readings themselves carry', () => {
    // Plain subtraction gives -0.19999999999999996 here.
    expect(readingDelta(179, 179.2)).toBe(-0.2);
    expect(readingDelta(178.6, 179.2)).toBe(-0.6);
    expect(readingDelta(0.3, 0.1)).toBe(0.2);
  });

  it('keeps whole readings whole', () => {
    expect(readingDelta(2840, 2785)).toBe(55);
    expect(readingDelta(2840, 2840)).toBe(0);
  });
});
