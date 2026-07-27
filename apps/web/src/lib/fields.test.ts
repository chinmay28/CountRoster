import { describe, it, expect } from 'vitest';
import type { TrackerField, TrackerFieldOption } from '@countroster/core';
import { fieldColumnBasis } from './fields.ts';

function field(overrides: Partial<TrackerField> = {}): TrackerField {
  return {
    id: 'f1',
    tracker_id: 't1',
    name: 'Wet diaper',
    kind: 'flag',
    unit: null,
    sort_order: 0,
    created_at: '2026-05-25T12:00:00.000-07:00',
    updated_at: '2026-05-25T12:00:00.000-07:00',
    options: [],
    ...overrides,
  };
}

function option(label: string, i: number): TrackerFieldOption {
  return { id: `o${i}`, field_id: 'f1', label, color: null, sort_order: i };
}

/** The rem number a basis asks for; `100%` means "a row to itself". */
function rem(basis: string): number {
  return basis === '100%' ? Infinity : Number(basis.replace('rem', ''));
}

describe('fieldColumnBasis', () => {
  it('keeps a yes/no field narrow enough for two to a row', () => {
    // The quick screen gives its fields ~20.5rem on a 390px phone; two
    // columns spend a 0.6rem gap on top of their own width.
    expect(2 * rem(fieldColumnBasis(field())) + 0.6).toBeLessThan(20.5);
  });

  it('asks for the room a long field name needs', () => {
    const short = rem(fieldColumnBasis(field({ name: 'Wet' })));
    const long = rem(fieldColumnBasis(field({ name: 'Wet diaper since the last feed' })));
    expect(long).toBeGreaterThan(short);
  });

  it('widens a choice field with its options', () => {
    const two = field({
      kind: 'choice',
      name: 'Side',
      options: [option('L', 0), option('R', 1)],
    });
    const many = field({
      kind: 'choice',
      name: 'Side',
      options: [option('Left breast', 0), option('Right breast', 1), option('Both', 2)],
    });
    expect(rem(fieldColumnBasis(two))).toBeLessThan(rem(fieldColumnBasis(many)));
    // Long labels outgrow a column, which is how a field claims its own row.
    expect(rem(fieldColumnBasis(many))).toBeGreaterThan(20.5 / 2);
  });

  it('gives free text a row of its own', () => {
    expect(fieldColumnBasis(field({ kind: 'text', name: 'Note' }))).toBe('100%');
  });

  it('leaves a number field room to type in', () => {
    expect(rem(fieldColumnBasis(field({ kind: 'number', name: 'Temp' })))).toBeGreaterThanOrEqual(8);
  });
});
