import { describe, it, expect } from 'vitest';
import {
  todayRange,
  sumValues,
  sumInRange,
  resetPeriodRange,
  resetPeriodOptions,
  windowStats,
  periodRowLabel,
  lastNBuckets,
  RESET_PERIOD_LABEL,
} from './range.ts';

/** The default period window: calendar days/months/years, weeks from Monday. */
const MONDAY = { week_start: 1 } as const;

describe('resetPeriodOptions', () => {
  const now = new Date('2026-05-20T14:00:00');

  it('is empty for never (no reset window) and for no entries', () => {
    expect(resetPeriodOptions('never', MONDAY, '2024-01-01T00:00:00.000-07:00', now)).toEqual([]);
    expect(resetPeriodOptions('yearly', MONDAY, undefined, now)).toEqual([]);
  });

  it('yearly walks back to the year of the first entry', () => {
    const opts = resetPeriodOptions('yearly', MONDAY, '2024-06-01T00:00:00.000-07:00', now);
    expect(opts.map((o) => o.label)).toEqual(['This year', 'Last year', '2024']);
    expect(opts[0]!.range.start).toMatch(/^2026-01-01T00:00:00/);
    expect(opts[0]!.range.end).toMatch(/^2027-01-01T00:00:00/);
    expect(opts[2]!.range.start).toMatch(/^2024-01-01T00:00:00/);
  });

  it('monthly labels older buckets by month and year', () => {
    const opts = resetPeriodOptions('monthly', MONDAY, '2026-02-10T00:00:00', now);
    expect(opts.map((o) => o.label)).toEqual([
      'This month',
      'Last month',
      'Mar 2026',
      'Feb 2026',
    ]);
    expect(opts[3]!.range.start).toMatch(/^2026-02-01T00:00:00/);
    expect(opts[3]!.range.end).toMatch(/^2026-03-01T00:00:00/);
  });

  it('daily uses Today/Yesterday then dates', () => {
    const opts = resetPeriodOptions('daily', MONDAY, '2026-05-18T09:00:00', now);
    expect(opts.map((o) => o.label)).toEqual(['Today', 'Yesterday', 'May 18']);
  });

  it('caps how far back the menu reaches', () => {
    const opts = resetPeriodOptions('daily', MONDAY, '2020-01-01T00:00:00', now, 10);
    expect(opts).toHaveLength(10);
  });
});

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
    expect(resetPeriodRange('never', MONDAY, now)).toBeNull();
  });

  it('daily spans the local calendar day', () => {
    const r = resetPeriodRange('daily', MONDAY, now)!;
    expect(r.start).toMatch(/^2026-05-20T00:00:00/);
    expect(r.end).toMatch(/^2026-05-21T00:00:00/);
  });

  it('monthly spans the calendar month', () => {
    const r = resetPeriodRange('monthly', MONDAY, now)!;
    expect(r.start).toMatch(/^2026-05-01T00:00:00/);
    expect(r.end).toMatch(/^2026-06-01T00:00:00/);
  });

  it('yearly spans the calendar year', () => {
    const r = resetPeriodRange('yearly', MONDAY, now)!;
    expect(r.start).toMatch(/^2026-01-01T00:00:00/);
    expect(r.end).toMatch(/^2027-01-01T00:00:00/);
  });

  it('weekly honors the week start (Monday)', () => {
    const r = resetPeriodRange('weekly', MONDAY, now)!; // week of Mon May 18
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
  const weekStart = MONDAY;
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

describe('period windows', () => {
  // A day running 7:00 AM -> 6:59 AM.
  const DAY_7AM = { day_start_minute: 7 * 60 } as const;

  it('todayRange follows the tracker\'s day window', () => {
    // 3:30 AM is still the previous day's window.
    const early = todayRange(new Date(2026, 4, 25, 3, 30), DAY_7AM);
    expect(early.start).toMatch(/^2026-05-24T07:00:00/);
    expect(early.end).toMatch(/^2026-05-25T07:00:00/);

    const later = todayRange(new Date(2026, 4, 25, 9, 0), DAY_7AM);
    expect(later.start).toMatch(/^2026-05-25T07:00:00/);
  });

  it('resetPeriodRange follows a custom month window', () => {
    const r = resetPeriodRange(
      'monthly',
      { month_start_day: 8 },
      new Date(2026, 4, 3, 12, 0),
    )!;
    expect(r.start).toMatch(/^2026-04-08T00:00:00/);
    expect(r.end).toMatch(/^2026-05-08T00:00:00/);
  });

  it('resetPeriodOptions walks back over custom month windows', () => {
    const opts = resetPeriodOptions(
      'monthly',
      { month_start_day: 8 },
      '2026-03-20T00:00:00',
      new Date(2026, 4, 20, 12, 0),
    );
    expect(opts.map((o) => o.label)).toEqual(['This month', 'Last month', 'Mar 2026']);
    expect(opts[0]!.range.start).toMatch(/^2026-05-08T00:00:00/);
    expect(opts[2]!.range.start).toMatch(/^2026-03-08T00:00:00/);
  });

  it('lastNBuckets aligns to a fiscal year window', () => {
    const r = lastNBuckets('year', 2, { year_start_month: 4 }, new Date(2026, 1, 10));
    expect(r.start).toMatch(/^2024-04-01T00:00:00/);
    expect(r.end).toMatch(/^2026-04-01T00:00:00/);
  });

  it('windowStats measures each window with the tracker\'s own boundaries', () => {
    const entries = [
      { value: 3, occurred_at: '2026-05-03T12:00:00' }, // April's window
      { value: 4, occurred_at: '2026-05-20T12:00:00' }, // May's window
    ];
    const now = new Date(2026, 4, 25, 12, 0);
    // With months opening on the 8th, only the May 20th entry is "this month".
    const monthly = windowStats(entries, { month_start_day: 8 }, now);
    expect(monthly.find((s) => s.key === 'month')!.value).toBe(4);
    // With calendar months both entries land in May, so the month total
    // equals the year total and collapses away.
    const calendar = windowStats(entries, {}, now);
    expect(calendar.find((s) => s.key === 'month')).toBeUndefined();
    expect(calendar.find((s) => s.key === 'all-time')!.value).toBe(7);
  });
});

describe('periodRowLabel', () => {
  const now = new Date('2026-05-20T14:00:00'); // a Wednesday
  // The stats service reports bucket starts in UTC ISO; build them the same
  // way the table receives them.
  const bucketOf = (period: 'day' | 'week' | 'month' | 'year', back: number) =>
    lastNBuckets(period, back + 1, MONDAY, now).start;

  it('names the two most recent buckets relatively', () => {
    expect(periodRowLabel(bucketOf('day', 0), 'day', MONDAY, now)).toBe('Today');
    expect(periodRowLabel(bucketOf('day', 1), 'day', MONDAY, now)).toBe('Yesterday');
    expect(periodRowLabel(bucketOf('week', 0), 'week', MONDAY, now)).toBe('This week');
    expect(periodRowLabel(bucketOf('week', 1), 'week', MONDAY, now)).toBe('Last week');
    expect(periodRowLabel(bucketOf('month', 0), 'month', MONDAY, now)).toBe('This month');
    expect(periodRowLabel(bucketOf('year', 1), 'year', MONDAY, now)).toBe('Last year');
  });

  it('dates anything older', () => {
    expect(periodRowLabel(bucketOf('month', 2), 'month', MONDAY, now)).toBe('Mar 2026');
    expect(periodRowLabel(bucketOf('year', 2), 'year', MONDAY, now)).toBe('2024');
    expect(periodRowLabel(bucketOf('week', 3), 'week', MONDAY, now)).toMatch(/^Week of /);
  });

  it('follows the tracker\'s week start', () => {
    // 2026-05-20 is a Wednesday: the Sunday-start week began a day earlier
    // than the Monday-start one, so "this week" names a different bucket.
    const SUNDAY = { week_start: 0 } as const;
    const mondayWeek = periodRowLabel(bucketOf('week', 0), 'week', MONDAY, now);
    const sundayStart = lastNBuckets('week', 1, SUNDAY, now).start;
    expect(mondayWeek).toBe('This week');
    expect(periodRowLabel(sundayStart, 'week', SUNDAY, now)).toBe('This week');
    // …and reading a Sunday-start bucket with Monday-start rules no longer
    // lines up with "this week".
    expect(periodRowLabel(sundayStart, 'week', MONDAY, now)).toMatch(/^Week of /);
  });

  it('returns an empty label for an unparseable instant', () => {
    expect(periodRowLabel('not-a-date', 'day', MONDAY, now)).toBe('');
  });
});
