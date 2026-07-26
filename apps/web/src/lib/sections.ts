/**
 * The tracker detail page is a stack of sections, and which order reads best
 * depends on the tracker: a habit is about the streak, a spending tracker
 * about the period table. The order is stored per tracker in
 * `trackers.section_order` as a comma-separated list of the keys below.
 *
 * The server keeps those keys opaque, so this module owns the whole
 * vocabulary — which sections exist, what they're called, and how a stored
 * order reconciles with the sections a given tracker actually has.
 */

/** Every section the detail page can render, in its default order. */
export const SECTION_KEYS = [
  'summary',
  'derivation',
  'composition',
  'fields',
  'trends',
  'log',
  'entries',
  'notes',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Names shown while rearranging — the section headings the user sees. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  summary: 'Summary',
  derivation: 'Derived from',
  composition: 'Breakdown',
  fields: 'Field breakdown',
  trends: 'Trends',
  log: 'Log an entry',
  entries: 'Entries',
  notes: 'Notes',
};

const KEY_INDEX = new Map<string, number>(SECTION_KEYS.map((k, i) => [k, i]));

/** Whether `key` is a section this build knows how to render. */
export function isSectionKey(key: string): key is SectionKey {
  return KEY_INDEX.has(key);
}

/**
 * Resolve the order to render in: the sections named by `stored` that this
 * tracker actually has, followed by the rest in default order.
 *
 * Both directions of drift are tolerated rather than rejected, because the
 * stored order outlives any one build: keys naming a section this tracker
 * doesn't have (or that no longer exists) are dropped, and sections the list
 * never mentions — a new one, or one that appeared when the tracker became
 * derived — fall back to their default position instead of vanishing.
 */
export function resolveSectionOrder(
  stored: string | null | undefined,
  available: readonly SectionKey[],
): SectionKey[] {
  const present = new Set(available);
  const ordered: SectionKey[] = [];
  for (const key of (stored ?? '').split(',')) {
    if (isSectionKey(key) && present.has(key) && !ordered.includes(key)) {
      ordered.push(key);
    }
  }
  const rest = available
    .filter((key) => !ordered.includes(key))
    .sort((a, b) => KEY_INDEX.get(a)! - KEY_INDEX.get(b)!);
  return [...ordered, ...rest];
}

/**
 * The value to persist for an order. Returns null — "no explicit order" —
 * when the order is just the default one, so a tracker the user never
 * rearranged keeps following the default as it evolves.
 */
export function serializeSectionOrder(
  order: readonly SectionKey[],
  available: readonly SectionKey[],
): string | null {
  const isDefault =
    order.length === available.length &&
    order.every((key, i) => resolveSectionOrder(null, available)[i] === key);
  return isDefault ? null : order.join(',');
}
