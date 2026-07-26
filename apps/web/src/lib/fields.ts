import type { Entry, EntryFieldValue, TrackerField } from '@countroster/core';

/**
 * Custom-field answers as the API takes them: field id → answer. The value's
 * meaning follows the field's kind (option id, 0|1 flag, number, text), and
 * null clears it.
 */
export type FieldAnswers = Record<string, string | number | boolean | null>;

/**
 * Fallback swatches for choice options the user never picked a color for, so
 * a breakdown legend still reads as distinct categories. Chosen to stay apart
 * in both themes and to survive the common forms of color blindness.
 */
const OPTION_PALETTE = [
  '#4ECDC4',
  '#F4A261',
  '#8E7DBE',
  '#6BAED6',
  '#E76F51',
  '#61A664',
  '#D4A5C4',
  '#B08968',
];

/** A stable color for a breakdown slice: the option's own, else the palette. */
export function sliceColor(color: string | null, index: number): string {
  return color ?? OPTION_PALETTE[index % OPTION_PALETTE.length]!;
}

/** This entry's answer for one field, or null if it left the field blank. */
export function answerFor(entry: Entry, fieldId: string): EntryFieldValue | null {
  return entry.fields.find((v) => v.field_id === fieldId) ?? null;
}

/**
 * An entry's answers in the shape the log/patch endpoints take, ready to seed
 * an edit form. Fields the entry never answered map to null so saving the form
 * unchanged is a no-op rather than a silent clear.
 */
export function answersFromEntry(
  entry: Entry,
  fields: readonly TrackerField[],
): FieldAnswers {
  const out: FieldAnswers = {};
  for (const field of fields) {
    const value = answerFor(entry, field.id);
    if (!value) {
      out[field.id] = null;
      continue;
    }
    out[field.id] =
      field.kind === 'choice'
        ? value.option_id
        : field.kind === 'text'
          ? value.text_value
          : value.number_value;
  }
  return out;
}

/** Answers with every field blank — the starting state of a log form. */
export function emptyAnswers(fields: readonly TrackerField[]): FieldAnswers {
  return Object.fromEntries(fields.map((f) => [f.id, null]));
}

/** True once at least one field has been answered. */
export function hasAnyAnswer(answers: FieldAnswers): boolean {
  return Object.values(answers).some((v) => v !== null && v !== '');
}

/**
 * How one answer reads on an entry row. A choice shows its option's label, a
 * flag reads as the field name with a tick or a cross, and number/text carry
 * the field name so a bare "12" is never ambiguous.
 */
export function formatAnswer(
  field: TrackerField,
  value: EntryFieldValue,
): { label: string; color: string | null } {
  switch (field.kind) {
    case 'choice': {
      const index = field.options.findIndex((o) => o.id === value.option_id);
      const option = field.options[index];
      return {
        label: option?.label ?? 'Unknown',
        color: option ? sliceColor(option.color, index) : null,
      };
    }
    case 'flag':
      return {
        label: `${value.number_value ? '✓' : '✗'} ${field.name}`,
        color: null,
      };
    case 'number': {
      const unit = field.unit ? ` ${field.unit}` : '';
      return { label: `${field.name} ${value.number_value ?? ''}${unit}`, color: null };
    }
    default:
      return { label: value.text_value ?? '', color: null };
  }
}

/** Every answer on an entry, in field order, ready to render as chips. */
export function entryChips(
  entry: Entry,
  fields: readonly TrackerField[],
): { key: string; label: string; color: string | null }[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const chips: { key: string; label: string; color: string | null }[] = [];
  for (const value of entry.fields) {
    const field = byId.get(value.field_id);
    if (!field) continue;
    chips.push({ key: value.id, ...formatAnswer(field, value) });
  }
  return chips;
}

/** Fields a breakdown can chart — a number field has no distinct answers. */
export function chartableFields(fields: readonly TrackerField[]): TrackerField[] {
  return fields.filter((f) => f.kind !== 'number');
}
