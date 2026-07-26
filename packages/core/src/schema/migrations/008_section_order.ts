/**
 * Migration 008 — per-tracker section order.
 *
 * The tracker detail page is a stack of sections (summary, trends, log,
 * entries, notes, …) and which order reads best depends on the tracker: a
 * habit is about the streak, a spending tracker about the period table. This
 * column stores the user's preferred order as a comma-separated list of
 * section keys — "summary,trends,log,entries,notes" — with NULL meaning "the
 * default order".
 *
 * A denormalized list rather than a join table: the whole value is read and
 * replaced as a unit, and it travels with the tracker row through backups.
 * The domain treats the keys as opaque slugs — which sections exist is the
 * client's business — so an order naming keys a client doesn't know is
 * ignored by that client rather than rejected by the server.
 */
export const M008_SECTION_ORDER = {
  version: 8,
  name: '008_section_order',
  up: /* sql */ `
    ALTER TABLE trackers ADD COLUMN section_order TEXT;
  `,
} as const;
