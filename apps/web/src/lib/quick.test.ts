import { describe, it, expect } from 'vitest';
import type { Tracker } from '@countroster/core';
import { applyStep, quickMode, roundToStep, stepSize } from './quick.ts';

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

  it('gives snapshot stats the stepper, whatever their kind', () => {
    expect(quickMode(tracker({ kind: 'number', is_snapshot: 1 }))).toBe('stepper');
    expect(quickMode(tracker({ kind: 'count', is_snapshot: 1 }))).toBe('stepper');
  });

  it('leaves derived trackers with no control at all', () => {
    expect(quickMode(tracker({ is_derived: 1 }))).toBe('readonly');
    // Derived wins over snapshot: a derived level still can't be logged.
    expect(quickMode(tracker({ is_derived: 1, is_snapshot: 1 }))).toBe('readonly');
  });
});

describe('stepSize', () => {
  it("uses the tracker's own default value as the step", () => {
    expect(stepSize(tracker({ default_value: 0.2 }))).toBe(0.2);
  });

  it('falls back to 1 when the default carries no usable step', () => {
    expect(stepSize(tracker({ default_value: 0 }))).toBe(1);
    expect(stepSize(tracker({ default_value: -2 }))).toBe(2);
  });
});

describe('applyStep', () => {
  it('steps at the precision of the step itself', () => {
    // Plain arithmetic gives 178.60000000000002 here.
    expect(applyStep(178.4, 0.2, 1)).toBe(178.6);
    expect(applyStep(178.4, 0.2, -1)).toBe(178.2);
  });

  it('leaves whole-number steps whole', () => {
    expect(applyStep(9, 1, 1)).toBe(10);
  });
});

describe('roundToStep', () => {
  it('rounds a difference to the step precision', () => {
    expect(roundToStep(178.6 - 179.2, 0.2)).toBe(-0.6);
    expect(roundToStep(0.30000000000000004, 0.1)).toBe(0.3);
  });
});
