/**
 * Pure geometry & percentage helpers for the composition donut chart.
 * Kept out of the component so they can be unit-tested without rendering.
 */

/**
 * Integer percentages that sum to exactly 100, by largest remainder —
 * plain rounding can total 99 or 101. All-zero (or non-positive-sum)
 * input yields all zeros.
 */
export function percentShares(values: readonly number[]): number[] {
  const sum = values.reduce((s, v) => s + v, 0);
  if (sum <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / sum) * 100);
  const out = exact.map(Math.floor);
  let leftover = 100 - out.reduce((s, v) => s + v, 0);
  // Hand the missing points to the largest fractional parts first.
  const byFraction = exact
    .map((v, i) => ({ i, fraction: v - Math.floor(v) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { i } of byFraction) {
    if (leftover <= 0) break;
    out[i]! += 1;
    leftover -= 1;
  }
  return out;
}

/**
 * SVG path for an annular (donut) sector from `start` to `end`, both as
 * fractions of the whole [0, 1], starting at 12 o'clock and running
 * clockwise. Callers must special-case a slice spanning the full circle
 * (start 0, end 1) — the arc endpoints coincide and the path degenerates;
 * draw a ring (stroked circle) instead.
 */
export function donutArcPath(
  start: number,
  end: number,
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
): string {
  const angle = (share: number) => -Math.PI / 2 + share * 2 * Math.PI;
  const a0 = angle(start);
  const a1 = angle(end);
  const large = end - start > 0.5 ? 1 : 0;
  const pt = (r: number, a: number) =>
    `${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
  return (
    `M ${pt(rOuter, a0)} ` +
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${pt(rOuter, a1)} ` +
    `L ${pt(rInner, a1)} ` +
    `A ${rInner} ${rInner} 0 ${large} 0 ${pt(rInner, a0)} Z`
  );
}

/** Trim float noise so paths stay short and stable. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
