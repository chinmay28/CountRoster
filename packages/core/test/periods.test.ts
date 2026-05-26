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
    const start = bucketStart(wed, 'week', 1);
    // Should be Monday, May 25, 2026
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(25);
  });

  it('week buckets honor Sunday-start', () => {
    // Wednesday, May 27, 2026
    const wed = new Date(2026, 4, 27, 14, 0, 0);
    const start = bucketStart(wed, 'week', 0);
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
    const start = bucketStart(wed, 'week', 1);
    const end = bucketEnd(wed, 'week', 1);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('month bucket end is the first of the next month', () => {
    const t = new Date(2026, 4, 25, 14, 0, 0);
    const end = bucketEnd(t, 'month');
    expect(end.getDate()).toBe(1);
    expect(end.getMonth()).toBe(5); // June
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
