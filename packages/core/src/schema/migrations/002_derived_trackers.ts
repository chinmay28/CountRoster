/**
 * Migration 002 — derived trackers.
 *
 * A *derived* tracker has no entries of its own; its value is computed from one
 * or more *source* trackers via a weighted linear combination. For example, a
 * "Profit" tracker links Revenue (coefficient +1) and Expenses (coefficient
 * -1): its value over any range is `(+1 × ΣRevenue) + (-1 × ΣExpenses)`.
 *
 * - `trackers.is_derived` flags such a tracker (and blocks direct logging).
 * - `tracker_links` holds the (source tracker, coefficient) operands.
 *
 * Each source entry `(value v at time t)` behaves like a virtual derived entry
 * of `coefficient × v` at `t`, so the existing sum-based aggregations
 * (home totals, stat buckets, target progress, streaks) compose unchanged.
 */
export const M002_DERIVED_TRACKERS = {
  version: 2,
  name: '002_derived_trackers',
  up: /* sql */ `
    ALTER TABLE trackers
      ADD COLUMN is_derived INTEGER NOT NULL DEFAULT 0
      CHECK (is_derived IN (0, 1));

    CREATE TABLE IF NOT EXISTS tracker_links (
      id           TEXT PRIMARY KEY,
      tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      source_id    TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      coefficient  REAL NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      UNIQUE (tracker_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS tracker_links_tracker_idx
      ON tracker_links (tracker_id, sort_order);
    CREATE INDEX IF NOT EXISTS tracker_links_source_idx
      ON tracker_links (source_id);
  `,
} as const;
