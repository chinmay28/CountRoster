import { describe, it, expect } from 'vitest';
import { todayRange, sumValues } from './range.ts';

describe('todayRange', () => {
  it('spans local midnight to next midnight, in local-offset ISO', () => {
    const { start, end } = todayRange(new Date('2026-05-25T14:32:00'));
    expect(start).toMatch(/T00:00:00/);
    expect(end).toMatch(/T00:00:00/);
    expect(start).not.toMatch(/Z$/);
    expect(start < end).toBe(true);
  });
});

describe('sumValues', () => {
  it('sums the value field', () => {
    expect(sumValues([{ value: 1 }, { value: 2.5 }, { value: -0.5 }])).toBe(3);
    expect(sumValues([])).toBe(0);
  });
});
