import { describe, it, expect } from 'vitest';
import {
  todayRange,
  sumValues,
  sumInRange,
  resetPeriodRange,
  windowStats,
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

describe('sumInRange', () => {
  it('sums only entries whose instant is in [start, end)', () => {
    const entries = [
      { value: 1, occurred_at: '2026-05-19T12:00:00-07:00' }, // before
      { value: 2, occurred_at: '2026-05-20T00:00:00-07:00' }, // start (inclusive)
      { value: 4, occurred_at: '2026-05-20T23:59:00-07:00' }, // inside
      { value: 8, occurred_at: '2026-05-21T00:00:00-07:00' }, // end (exclusive)
    ];
    const sum = sumInRange(entries, {
      start: '2026-05-20T00:00:00-07:00',
      end: '2026-05-21T00:00:00-07:00',
    });
    expect(sum).toBe(6);
  });
});

describe('windowStats', () => {
  const weekStart = 1; // Monday
  const now = new Date('2026-05-20T14:00:00'); // a Wednesday

  function entry(value: number, occurred_at: string) {
    return { value, occurred_at };
  }

  it('breaks the total into this week / month / year / all-time', () => {
    const stats = windowStats(
      [
        entry(1, '2026-05-20T09:00:00'), // this week (Mon May 18–24)
        entry(2, '2026-05-04T09:00:00'), // earlier this month
        entry(4, '2026-02-01T09:00:00'), // earlier this year
        entry(8, '2025-06-01T09:00:00'), // a prior year
      ],
      weekStart,
      now,
    );
    expect(stats.map((s) => [s.key, s.value])).toEqual([
      ['week', 1],
      ['month', 3],
      ['year', 7],
      ['all-time', 15],
    ]);
  });

  it('collapses a narrower window that equals the next broader one', () => {
    // Nothing this week and nothing this month: the zero week adds no info over
    // the zero month, so it's dropped. The zero month is kept because it differs
    // from the year — it tells you the year's activity was all before May.
    const stats = windowStats(
      [entry(5, '2026-02-01T09:00:00'), entry(3, '2025-06-01T09:00:00')],
      weekStart,
      now,
    );
    expect(stats.map((s) => [s.key, s.value])).toEqual([
      ['month', 0],
      ['year', 5],
      ['all-time', 8],
    ]);
  });

  it('collapses to a single all-time figure when every window is equal', () => {
    const stats = windowStats([entry(5, '2026-05-20T09:00:00')], weekStart, now);
    expect(stats).toEqual([{ key: 'all-time', label: 'all-time', value: 5 }]);
  });

  it('returns a single zero all-time stat for no entries', () => {
    expect(windowStats([], weekStart, now)).toEqual([
      { key: 'all-time', label: 'all-time', value: 0 },
    ]);
  });
});
