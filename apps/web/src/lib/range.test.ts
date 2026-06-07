import { describe, it, expect } from 'vitest';
import {
  todayRange,
  sumValues,
  resetPeriodRange,
  RESET_PERIOD_LABEL,
} from './range.ts';

describe('todayRange', () => {
  it('spans local midnight to next midnight, in local-offset ISO', () => {
    const { start, end } = todayRange(new Date('2026-05-25T14:32:00'));
    expect(start).toMatch(/T00:00:00/);
    expect(end).toMatch(/T00:00:00/);
    expect(start).not.toMatch(/Z$/);
    expect(start < end).toBe(true);
  });
});

describe('resetPeriodRange', () => {
  const now = new Date('2026-05-20T14:00:00'); // a Wednesday

  it('returns null for never (cumulative, no window)', () => {
    expect(resetPeriodRange('never', 1, now)).toBeNull();
  });

  it('daily spans the local calendar day', () => {
    const r = resetPeriodRange('daily', 1, now)!;
    expect(r.start).toMatch(/^2026-05-20T00:00:00/);
    expect(r.end).toMatch(/^2026-05-21T00:00:00/);
  });

  it('monthly spans the calendar month', () => {
    const r = resetPeriodRange('monthly', 1, now)!;
    expect(r.start).toMatch(/^2026-05-01T00:00:00/);
    expect(r.end).toMatch(/^2026-06-01T00:00:00/);
  });

  it('yearly spans the calendar year', () => {
    const r = resetPeriodRange('yearly', 1, now)!;
    expect(r.start).toMatch(/^2026-01-01T00:00:00/);
    expect(r.end).toMatch(/^2027-01-01T00:00:00/);
  });

  it('weekly honors the week start (Monday)', () => {
    const r = resetPeriodRange('weekly', 1, now)!; // week of Mon May 18
    expect(r.start).toMatch(/^2026-05-18T00:00:00/);
    expect(r.end).toMatch(/^2026-05-25T00:00:00/);
  });

  it('has a human label for every period', () => {
    expect(RESET_PERIOD_LABEL.weekly).toBe('this week');
    expect(RESET_PERIOD_LABEL.never).toBe('all time');
  });
});

describe('sumValues', () => {
  it('sums the value field', () => {
    expect(sumValues([{ value: 1 }, { value: 2.5 }, { value: -0.5 }])).toBe(3);
    expect(sumValues([])).toBe(0);
  });
});
