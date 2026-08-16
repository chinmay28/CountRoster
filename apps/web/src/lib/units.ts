import { parseSecondaryUnit, type SecondaryUnitPart, type Tracker } from '@countroster/core';
import { formatNumber } from './format.ts';

/**
 * Secondary units: reading a value in a unit other than the one it was logged
 * in. A weight kept in grams is *thought about* in pounds and ounces; a
 * distance in kilometres is quoted in miles. Nothing about the stored value
 * changes — the client converts it and shows the result as a small line under
 * the headline number.
 *
 * The conversion is a multiplication (`secondary_factor`) into a unit spec
 * (`secondary_unit`) that carries its own subdivisions, so "lb+16oz" renders
 * 3350 g as "7 lb 6.17 oz" without a conversion table shipping alongside.
 * Offset scales (°C → °F) are out of scope — a factor can't express them.
 */

/** One conversion offered by the tracker form. */
export interface UnitPreset {
  /** What the menu calls it, e.g. "pounds + ounces". */
  label: string;
  /** The stored `secondary_unit` spec. */
  unit: string;
  /** The stored `secondary_factor`. */
  factor: number;
}

interface PresetGroup {
  /** Lowercased primary units this group is offered for. */
  from: readonly string[];
  presets: readonly UnitPreset[];
}

const G_TO_LB = 0.002204622621848776;
const ML_TO_FLOZ = 0.0338140227018;

/**
 * Conversions suggested for a given primary unit. Not exhaustive and not a
 * constraint — the form always allows a hand-entered unit and factor, so an
 * unlisted primary unit (or an unlisted target) is a menu gap, not a wall.
 */
const PRESET_GROUPS: readonly PresetGroup[] = [
  {
    from: ['g', 'gram', 'grams', 'gm', 'gms'],
    presets: [
      { label: 'pounds + ounces', unit: 'lb+16oz', factor: G_TO_LB },
      { label: 'pounds', unit: 'lb', factor: G_TO_LB },
      { label: 'ounces', unit: 'oz', factor: 0.03527396194958041 },
      { label: 'kilograms', unit: 'kg', factor: 0.001 },
    ],
  },
  {
    from: ['kg', 'kgs', 'kilogram', 'kilograms'],
    presets: [
      { label: 'pounds + ounces', unit: 'lb+16oz', factor: 2.204622621848776 },
      { label: 'pounds', unit: 'lb', factor: 2.204622621848776 },
      { label: 'stone + pounds', unit: 'st+14lb', factor: 0.15747304441777 },
      { label: 'grams', unit: 'g', factor: 1000 },
    ],
  },
  {
    from: ['lb', 'lbs', 'pound', 'pounds'],
    presets: [
      { label: 'kilograms', unit: 'kg', factor: 0.45359237 },
      { label: 'grams', unit: 'g', factor: 453.59237 },
      { label: 'ounces', unit: 'oz', factor: 16 },
    ],
  },
  {
    from: ['oz', 'ounce', 'ounces'],
    presets: [
      { label: 'grams', unit: 'g', factor: 28.349523125 },
      { label: 'pounds + ounces', unit: 'lb+16oz', factor: 0.0625 },
    ],
  },
  {
    from: ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
    presets: [
      { label: 'fluid ounces', unit: 'fl oz', factor: ML_TO_FLOZ },
      { label: 'cups', unit: 'cups', factor: 0.00422675283773 },
      { label: 'litres', unit: 'L', factor: 0.001 },
    ],
  },
  {
    from: ['l', 'litre', 'litres', 'liter', 'liters'],
    presets: [
      { label: 'gallons', unit: 'gal', factor: 0.264172052358 },
      { label: 'fluid ounces', unit: 'fl oz', factor: 33.8140227018 },
      { label: 'millilitres', unit: 'ml', factor: 1000 },
    ],
  },
  {
    from: ['cup', 'cups'],
    presets: [
      { label: 'millilitres', unit: 'ml', factor: 236.5882365 },
      { label: 'fluid ounces', unit: 'fl oz', factor: 8 },
    ],
  },
  {
    from: ['km', 'kilometre', 'kilometres', 'kilometer', 'kilometers'],
    presets: [
      { label: 'miles', unit: 'mi', factor: 0.621371192237 },
      { label: 'metres', unit: 'm', factor: 1000 },
    ],
  },
  {
    from: ['mi', 'mile', 'miles'],
    presets: [{ label: 'kilometres', unit: 'km', factor: 1.609344 }],
  },
  {
    from: ['m', 'metre', 'metres', 'meter', 'meters'],
    presets: [
      { label: 'feet + inches', unit: 'ft+12in', factor: 3.28083989501 },
      { label: 'feet', unit: 'ft', factor: 3.28083989501 },
      { label: 'kilometres', unit: 'km', factor: 0.001 },
    ],
  },
  {
    from: ['cm', 'centimetre', 'centimetres', 'centimeter', 'centimeters'],
    presets: [
      { label: 'feet + inches', unit: 'ft+12in', factor: 0.0328083989501 },
      { label: 'inches', unit: 'in', factor: 0.393700787402 },
    ],
  },
  {
    from: ['in', 'inch', 'inches'],
    presets: [
      { label: 'centimetres', unit: 'cm', factor: 2.54 },
      { label: 'feet + inches', unit: 'ft+12in', factor: 1 / 12 },
    ],
  },
  {
    from: ['ft', 'foot', 'feet'],
    presets: [
      { label: 'metres', unit: 'm', factor: 0.3048 },
      { label: 'centimetres', unit: 'cm', factor: 30.48 },
    ],
  },
  {
    from: ['kcal', 'cal', 'calorie', 'calories'],
    presets: [{ label: 'kilojoules', unit: 'kJ', factor: 4.184 }],
  },
];

/** The conversions worth offering for a primary unit; empty when unknown. */
export function presetsFor(unit: string | null | undefined): readonly UnitPreset[] {
  const key = (unit ?? '').trim().toLowerCase();
  if (!key) return [];
  return PRESET_GROUPS.find((g) => g.from.includes(key))?.presets ?? [];
}

/** Round to 2 decimals, the precision every displayed number in the app uses. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Render `converted` — already in the secondary unit — across the spec's
 * parts: 7.3855 over `lb+16oz` reads "7 lb 6.17 oz".
 *
 * The value is rounded up front, in the *smallest* part's terms, and only
 * then broken up. Rounding each part as it is peeled off would let the last
 * one round up to a whole of the part above it ("7 lb 16 oz"); doing it first
 * makes that carry land where it belongs.
 */
function formatParts(converted: number, parts: SecondaryUnitPart[]): string {
  const sign = converted < 0 ? '-' : '';
  // How many of the smallest unit make one of each part.
  const sizes = parts.map((_, i) =>
    parts.slice(i + 1).reduce((acc, p) => acc * p.per, 1),
  );
  let rest = round2(Math.abs(converted) * sizes[0]!);

  const segments: string[] = [];
  parts.forEach((part, i) => {
    const size = sizes[i]!;
    if (i === parts.length - 1) {
      const last = round2(rest / size);
      if (last !== 0) segments.push(`${last} ${part.label}`);
      return;
    }
    const whole = Math.floor(rest / size);
    rest -= whole * size;
    if (whole !== 0) segments.push(`${whole} ${part.label}`);
  });

  // Everything rounded away — say so in the largest unit rather than "".
  if (segments.length === 0) return `0 ${parts[0]!.label}`;
  return sign + segments.join(' ');
}

/**
 * The tracker's value read in its secondary unit, or null when it has none
 * (or the pair is incomplete — the two columns only mean something together).
 * Kinds that don't render as a plain number — a duration, a yes/no — have no
 * unit to convert, so they get no secondary reading either.
 */
export function formatSecondary(
  // Only the three fields the reading needs, so a form can preview a unit it
  // hasn't saved onto a tracker yet.
  tracker: Pick<Tracker, 'kind' | 'secondary_unit' | 'secondary_factor'>,
  value: number,
): string | null {
  if (tracker.kind === 'duration' || tracker.kind === 'boolean') return null;
  const spec = tracker.secondary_unit?.trim();
  const factor = tracker.secondary_factor;
  if (!spec || factor == null || !Number.isFinite(factor)) return null;
  const parts = parseSecondaryUnit(spec);
  if (!parts) return null;
  const converted = value * factor;
  // A single unit reads like any other number in the app — currency symbols
  // ahead of the digits, thousands separators, no trailing zeros.
  if (parts.length === 1) return formatNumber(converted, parts[0]!.label);
  return formatParts(converted, parts);
}
