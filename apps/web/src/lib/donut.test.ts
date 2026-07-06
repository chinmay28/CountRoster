import { describe, it, expect } from 'vitest';
import { donutArcPath, percentShares } from './donut.ts';

describe('percentShares', () => {
  it('splits clean fractions', () => {
    expect(percentShares([300, 100])).toEqual([75, 25]);
  });

  it('sums to exactly 100 when rounding would drift', () => {
    // Thirds round to 33 each (99); largest remainder tops one back up.
    const shares = percentShares([1, 1, 1]);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(100);
    expect(shares.sort()).toEqual([33, 33, 34]);
  });

  it('gives every point to a lone contributor', () => {
    expect(percentShares([0, 5, 0])).toEqual([0, 100, 0]);
  });

  it('returns zeros when nothing has been logged', () => {
    expect(percentShares([0, 0])).toEqual([0, 0]);
  });
});

describe('donutArcPath', () => {
  it('starts a slice at 12 o\'clock on the outer radius', () => {
    const path = donutArcPath(0, 0.25, 80, 80, 76, 50);
    // First point: cx + r·cos(−90°), cy + r·sin(−90°) = (80, 4).
    expect(path.startsWith('M 80 4 ')).toBe(true);
    // A quarter slice is a minor arc.
    expect(path).toContain('A 76 76 0 0 1');
  });

  it('uses the large-arc flag past half the circle', () => {
    const path = donutArcPath(0, 0.75, 80, 80, 76, 50);
    expect(path).toContain('A 76 76 0 1 1');
  });
});
