/**
 * The secondary-unit spec: the grammar behind `trackers.secondary_unit`.
 *
 * A tracker stores its value in one unit and may *read* it in another — grams
 * logged, pounds and ounces displayed. The spec names the display unit, and
 * carries its own subdivisions so the reading is self-describing:
 *
 *   "lb"       → 7.39 lb
 *   "lb+16oz"  → 7 lb 6.17 oz     (16 oz make 1 lb)
 *   "ft+12in"  → 5 ft 10 in
 *
 * Parts are joined with "+"; every part after the first is prefixed by how
 * many of it make one of the part before it. The domain only pins the shape —
 * what the labels mean is the reader's business, exactly as with a tracker's
 * primary `unit`.
 *
 * The Go server mirrors this validation in `internal/core/validate.go`; the
 * formatting that consumes a parsed spec lives in the web client.
 */

/** Max length of a secondary-unit spec, matching the primary unit's limit. */
export const MAX_SECONDARY_UNIT_LENGTH = 40;

/** Most parts a spec may name: "st+14lb+16oz" is already an unusual reading. */
export const MAX_SECONDARY_UNIT_PARTS = 3;

/** One unit in a spec: its label, and how many of it make one of the part
 * before it (1 for the first part, which the factor converts into). */
export interface SecondaryUnitPart {
  label: string;
  per: number;
}

/**
 * Leading count on a subdivision part: "16oz" → 16 and "oz". The label may
 * not start with a digit, so a bare count ("lb+16") is a malformed part
 * rather than 1 of a unit named "6".
 */
const SUBDIVISION_RE = /^(\d+(?:\.\d+)?)\s*([^\d\s].*)$/;

/**
 * Parse a secondary-unit spec into its parts, or null if it is malformed.
 * Whitespace around a part is insignificant, so "lb + 16 oz" parses the same
 * as "lb+16oz".
 */
export function parseSecondaryUnit(spec: string): SecondaryUnitPart[] | null {
  if (spec.length > MAX_SECONDARY_UNIT_LENGTH) return null;
  const raw = spec.split('+');
  if (raw.length > MAX_SECONDARY_UNIT_PARTS) return null;

  const parts: SecondaryUnitPart[] = [];
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i]!.trim();
    if (!text) return null;
    if (i === 0) {
      // The first part is a plain label — the unit the factor converts into.
      parts.push({ label: text, per: 1 });
      continue;
    }
    const m = SUBDIVISION_RE.exec(text);
    if (!m) return null;
    const per = Number(m[1]);
    if (!Number.isFinite(per) || per <= 0) return null;
    parts.push({ label: m[2]!.trim(), per });
  }
  return parts;
}

/** Whether a spec is well-formed. The empty string is allowed and means the
 * same as null: no secondary unit. */
export function isSecondaryUnit(spec: string): boolean {
  return spec === '' || parseSecondaryUnit(spec) !== null;
}
