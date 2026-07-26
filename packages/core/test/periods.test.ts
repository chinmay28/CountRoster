import { describe, it, expect } from 'vitest';
import {
  bucketStart,
  bucketEnd,
  bucketLabel,
} from '../src/aggregations/periods.js';

describe('bucketStart', () => {
  it('day buckets start at local midnight', () => {
    const t = new Date(2026, 4, 25, 14, 32, 0); // May 25, 2026 14:32 local
    const start = bucketStart(t, 'day');
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(25);
  });

  it('week buckets default to Monday-start', () => {
    // Wednesday, May 27, 2026
    const wed = new Date(2026, 4, 27, 14, 0, 0);
    const start = bucketStart(wed, 'week', { week_start: 1 });
    // Should be Monday, May 25, 2026
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(25);
  });

  it('week buckets honor Sunday-start', () => {
    // Wednesday, May 27, 2026
    const wed = new Date(2026, 4, 27, 14, 0, 0);
    const start = bucketStart(wed, 'week', { week_start: 0 });
    // Should be Sunday, May 24, 2026
    expect(start.getDay()).toBe(0);
    expect(start.getDate()).toBe(24);
  });

  it('month buckets start at the first of the month', () => {
    const t = new Date(2026, 4, 25, 14, 0, 0);
    const start = bucketStart(t, 'month');
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(4); // May
  });

  it('year buckets start at January 1st', () => {
    const t = new Date(2026, 4, 25, 14, 0, 0);
    const start = bucketStart(t, 'year');
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
    expect(start.getFullYear()).toBe(2026);
  });
});

describe('bucketEnd', () => {
  it('day bucket end is the next day at midnight', () => {
    const t = new Date(2026, 4, 25, 14, 0, 0);
    const end = bucketEnd(t, 'day');
    expect(end.getDate()).toBe(26);
    expect(end.getHours()).toBe(0);
  });

  it('week bucket end is 7 days after the start', () => {
    const wed = new Date(2026, 4, 27, 14, 0, 0);
    const start = bucketStart(wed, 'week', { week_start: 1 });
    const end = bucketEnd(wed, 'week', { week_start: 1 });
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('month bucket end is the first of the next month', () => {
    const t = new Date(2026, 4, 25, 14, 0, 0);
    const end = bucketEnd(t, 'month');
    expect(end.getDate()).toBe(1);
    expect(end.getMonth()).toBe(5); // June
  });
});

describe('custom period windows', () => {
  // A day running 7:00 AM -> 6:59 AM.
  const dayStart = { day_start_minute: 7 * 60 } as const;

  it('day buckets open at day_start_minute', () => {
    const morning = new Date(2026, 4, 25, 9, 0, 0);
    const start = bucketStart(morning, 'day', dayStart);
    expect(start.getDate()).toBe(25);
    expect(start.getHours()).toBe(7);
    expect(bucketEnd(morning, 'day', dayStart).getDate()).toBe(26);
  });

  it('an instant before the day opens belongs to the previous day', () => {
    const preDawn = new Date(2026, 4, 25, 3, 30, 0);
    const start = bucketStart(preDawn, 'day', dayStart);
    expect(start.getDate()).toBe(24);
    expect(start.getHours()).toBe(7);
    expect(bucketLabel(start, 'day')).toBe('2026-05-24');
  });

  it('week and month buckets shift with the day start too', () => {
    const mondayPreDawn = new Date(2026, 4, 25, 3, 30, 0); // Monday
    const week = bucketStart(mondayPreDawn, 'week', dayStart);
    expect(week.getDate()).toBe(18);
    expect(week.getHours()).toBe(7);

    const firstPreDawn = new Date(2026, 4, 1, 3, 30, 0);
    const month = bucketStart(firstPreDawn, 'month', dayStart);
    expect(month.getMonth()).toBe(3); // April
    expect(month.getDate()).toBe(1);
  });

  it('month buckets open on month_start_day', () => {
    const window = { month_start_day: 8 } as const;
    const after = bucketStart(new Date(2026, 4, 20, 12, 0), 'month', window);
    expect(after.getMonth()).toBe(4); // May
    expect(after.getDate()).toBe(8);

    const before = new Date(2026, 4, 3, 12, 0);
    const start = bucketStart(before, 'month', window);
    expect(start.getMonth()).toBe(3); // April
    expect(start.getDate()).toBe(8);
    expect(bucketLabel(start, 'month')).toBe('2026-04');

    const end = bucketEnd(before, 'month', window);
    expect(end.getMonth()).toBe(4); // May
    expect(end.getDate()).toBe(8);

    // A January window opens on the 8th, so the 3rd is December's.
    const december = bucketStart(new Date(2026, 0, 3, 12, 0), 'month', window);
    expect(december.getFullYear()).toBe(2025);
    expect(december.getMonth()).toBe(11);
  });

  it('year buckets open on year_start_month', () => {
    const window = { year_start_month: 4 } as const; // April -> March
    const may = bucketStart(new Date(2026, 4, 20, 12, 0), 'year', window);
    expect(may.getFullYear()).toBe(2026);
    expect(may.getMonth()).toBe(3);

    const feb = new Date(2026, 1, 10, 12, 0);
    expect(bucketStart(feb, 'year', window).getFullYear()).toBe(2025);
    const end = bucketEnd(feb, 'year', window);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(3);

    // year_start_month composes with month_start_day (UK tax year).
    const uk = { year_start_month: 4, month_start_day: 6 } as const;
    const april5 = bucketStart(new Date(2026, 3, 5, 12, 0), 'year', uk);
    expect(april5.getFullYear()).toBe(2025);
    expect(april5.getDate()).toBe(6);
  });

  it('falls back to the calendar for out-of-range components', () => {
    // Rows written before migration 006 read back as 0 for the new columns.
    const legacy = { month_start_day: 0, year_start_month: 0 } as const;
    const start = bucketStart(new Date(2026, 4, 20, 12, 0), 'month', legacy);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(4);
  });
});

describe('bucketLabel', () => {
  it('formats day labels as YYYY-MM-DD', () => {
    const t = new Date(2026, 0, 5, 0, 0, 0);
    expect(bucketLabel(t, 'day')).toBe('2026-01-05');
  });

  it('formats month labels as YYYY-MM', () => {
    const t = new Date(2026, 4, 1, 0, 0, 0);
    expect(bucketLabel(t, 'month')).toBe('2026-05');
  });

  it('formats year labels as YYYY', () => {
    const t = new Date(2026, 0, 1);
    expect(bucketLabel(t, 'year')).toBe('2026');
  });

  it('formats week labels as YYYY-Www', () => {
    // Monday, Jan 5, 2026 (ISO week 2 of 2026)
    const t = new Date(2026, 0, 5);
    expect(bucketLabel(t, 'week')).toMatch(/^2026-W\d{2}$/);
  });
});
