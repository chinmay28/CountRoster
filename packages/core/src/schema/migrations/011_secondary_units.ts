/**
 * Migration 011 — optional secondary unit.
 *
 * A tracker's value is recorded in one unit, but that unit is not always the
 * one the number is *read* in: a weight logged in grams is thought about in
 * pounds and ounces, a distance in kilometres is quoted in miles. Rather than
 * force the choice at logging time — which would change what's stored, and
 * with it every past entry — a tracker may carry a second unit that exists
 * purely for display: the client converts the value and shows the result as a
 * small line under the primary one.
 *
 * `secondary_factor` is the multiplier from the primary value to the
 * secondary unit (grams → pounds is 0.00220462…). `secondary_unit` is the
 * unit's spec: a plain label ("lb", "mi"), or several parts joined with "+"
 * where each later part is prefixed by how many of it make one of the part
 * before it — "lb+16oz" renders 3350 g as "7 lb 6.17 oz", "ft+12in" as
 * "5 ft 10 in". Self-describing, so no conversion table has to be shipped
 * alongside the database for a stored value to be readable.
 *
 * Both columns are nullable and only mean anything together: a tracker with
 * one and not the other simply has no secondary reading. The conversion is a
 * pure multiplication, so offset scales (°C → °F) are deliberately out of
 * scope.
 */
export const M011_SECONDARY_UNITS = {
  version: 11,
  name: '011_secondary_units',
  up: /* sql */ `
    ALTER TABLE trackers ADD COLUMN secondary_unit TEXT;
    ALTER TABLE trackers ADD COLUMN secondary_factor REAL;
  `,
} as const;
