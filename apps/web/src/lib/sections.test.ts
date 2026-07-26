import { describe, it, expect } from 'vitest';
import {
  SECTION_KEYS,
  isSectionKey,
  resolveSectionOrder,
  serializeSectionOrder,
  type SectionKey,
} from './sections.ts';

/** The sections an ordinary, directly-logged tracker has. */
const ORDINARY: SectionKey[] = ['summary', 'trends', 'log', 'entries', 'notes'];

describe('resolveSectionOrder', () => {
  it('falls back to the default order when nothing is stored', () => {
    expect(resolveSectionOrder(null, ORDINARY)).toEqual(ORDINARY);
    expect(resolveSectionOrder(undefined, ORDINARY)).toEqual(ORDINARY);
    expect(resolveSectionOrder('', ORDINARY)).toEqual(ORDINARY);
  });

  it('honours a stored order', () => {
    expect(resolveSectionOrder('entries,summary,trends,log,notes', ORDINARY)).toEqual([
      'entries',
      'summary',
      'trends',
      'log',
      'notes',
    ]);
  });

  it('appends sections the stored order never mentions, in default order', () => {
    // An order saved before "trends" existed still renders it — in its
    // default position, not dropped.
    expect(resolveSectionOrder('entries,notes', ORDINARY)).toEqual([
      'entries',
      'notes',
      'summary',
      'trends',
      'log',
    ]);
  });

  it('drops keys the tracker has no section for', () => {
    // "log" belongs to a directly-logged tracker; a derived one can't be
    // logged to, so an order carrying it must not render a logging form.
    const derived: SectionKey[] = ['summary', 'derivation', 'trends', 'entries', 'notes'];
    expect(resolveSectionOrder('log,entries,summary', derived)).toEqual([
      'entries',
      'summary',
      'derivation',
      'trends',
      'notes',
    ]);
  });

  it('ignores unknown keys and duplicates', () => {
    expect(resolveSectionOrder('entries,bogus,entries,summary', ORDINARY)).toEqual([
      'entries',
      'summary',
      'trends',
      'log',
      'notes',
    ]);
  });
});

describe('serializeSectionOrder', () => {
  it('stores null for the default order, so it can keep evolving', () => {
    expect(serializeSectionOrder(ORDINARY, ORDINARY)).toBeNull();
  });

  it('stores a comma-separated list for a rearranged order', () => {
    const rearranged: SectionKey[] = ['entries', 'summary', 'trends', 'log', 'notes'];
    expect(serializeSectionOrder(rearranged, ORDINARY)).toBe(
      'entries,summary,trends,log,notes',
    );
  });

  it('round-trips through resolveSectionOrder', () => {
    const rearranged: SectionKey[] = ['notes', 'entries', 'log', 'trends', 'summary'];
    const stored = serializeSectionOrder(rearranged, ORDINARY);
    expect(resolveSectionOrder(stored, ORDINARY)).toEqual(rearranged);
  });

  it('produces a value the server validator accepts', () => {
    const stored = serializeSectionOrder(
      ['notes', 'entries', 'log', 'trends', 'summary'],
      ORDINARY,
    );
    expect(stored).toMatch(/^[a-z][a-z0-9_-]*(,[a-z][a-z0-9_-]*)*$/);
  });
});

describe('isSectionKey', () => {
  it('accepts every known key and nothing else', () => {
    for (const key of SECTION_KEYS) expect(isSectionKey(key)).toBe(true);
    expect(isSectionKey('reminders')).toBe(false);
  });
});
