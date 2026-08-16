import { describe, it, expect } from 'vitest';
import type { Tracker } from '@countroster/core';
import { formatSecondary, presetsFor } from './units.ts';

const G_TO_LB = 0.002204622621848776;

/** Just the fields a secondary reading is computed from. */
function reading(
  secondary_unit: string | null,
  secondary_factor: number | null,
  kind: Tracker['kind'] = 'number',
) {
  return { kind, secondary_unit, secondary_factor };
}

describe('formatSecondary', () => {
  it('reads a compound unit down to its subdivision', () => {
    // The headline case: a weight kept in grams, read in pounds and ounces.
    expect(formatSecondary(reading('lb+16oz', G_TO_LB), 3350)).toBe('7 lb 6.17 oz');
  });

  it('reads a single unit like any other number', () => {
    expect(formatSecondary(reading('lb', G_TO_LB), 3350)).toBe('7.39 lb');
    expect(formatSecondary(reading('kg', 0.001), 3350)).toBe('3.35 kg');
  });

  it('writes a currency secondary unit the way money reads', () => {
    expect(formatSecondary(reading('$', 1.08), 1000)).toBe('$1,080');
  });

  it('drops the parts that came out empty', () => {
    // A whole number of pounds says so, rather than "7 lb 0 oz"…
    expect(formatSecondary(reading('lb+16oz', 1), 7)).toBe('7 lb');
    // …and under a pound there is no pound to name.
    expect(formatSecondary(reading('lb+16oz', 1), 0.5)).toBe('8 oz');
  });

  it('names the largest unit when there is nothing to show', () => {
    expect(formatSecondary(reading('lb+16oz', G_TO_LB), 0)).toBe('0 lb');
  });

  it('carries a rounded subdivision into the unit above it', () => {
    // 7.9999 lb is 15.9984 oz short of 8 — rounding the ounces alone would
    // print "7 lb 16 oz".
    expect(formatSecondary(reading('lb+16oz', 1), 7.9999)).toBe('8 lb');
  });

  it('signs the whole reading, not one of its parts', () => {
    expect(formatSecondary(reading('lb+16oz', 1), -7.5)).toBe('-7 lb 8 oz');
  });

  it('handles three parts', () => {
    // 100 kg is 220.46 lb: 15 stone (210 lb), 10 lb and 7.4 oz over.
    expect(formatSecondary(reading('st+14lb+16oz', 0.15747304441777), 100)).toBe(
      '15 st 10 lb 7.4 oz',
    );
  });

  it('ignores whitespace inside a spec', () => {
    expect(formatSecondary(reading('lb + 16 oz', 1), 7.5)).toBe('7 lb 8 oz');
  });

  it('has no reading without both halves of the pair', () => {
    expect(formatSecondary(reading(null, null), 100)).toBeNull();
    expect(formatSecondary(reading('lb', null), 100)).toBeNull();
    expect(formatSecondary(reading(null, 2), 100)).toBeNull();
    expect(formatSecondary(reading('', 2), 100)).toBeNull();
  });

  it('has no reading for a malformed spec', () => {
    expect(formatSecondary(reading('lb+oz', 1), 100)).toBeNull();
  });

  it('has no reading for a kind that is not shown as a plain number', () => {
    expect(formatSecondary(reading('lb', 1, 'duration'), 100)).toBeNull();
    expect(formatSecondary(reading('lb', 1, 'boolean'), 100)).toBeNull();
    expect(formatSecondary(reading('lb', 1, 'count'), 100)).toBe('100 lb');
  });
});

describe('presetsFor', () => {
  it('suggests conversions for a known primary unit, however it was typed', () => {
    expect(presetsFor('g').map((p) => p.unit)).toContain('lb+16oz');
    expect(presetsFor(' Grams ').map((p) => p.unit)).toContain('lb+16oz');
  });

  it('suggests nothing for a unit it does not know', () => {
    expect(presetsFor('widgets')).toEqual([]);
    expect(presetsFor(null)).toEqual([]);
    expect(presetsFor('')).toEqual([]);
  });

  it('offers presets that convert as advertised', () => {
    const lbOz = presetsFor('kg').find((p) => p.unit === 'lb+16oz')!;
    expect(formatSecondary(reading(lbOz.unit, lbOz.factor), 3.35)).toBe('7 lb 6.17 oz');
  });
});
