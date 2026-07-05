/**
 * Migration 004 — snapshot trackers.
 *
 * A *snapshot* tracker records the level of a statistic at a point in time
 * (net worth, body weight, subscriber count) rather than an amount to add up.
 * Its entries never accumulate: the current value is simply the most recent
 * entry, and aggregations take the last snapshot in a period instead of the
 * sum over it.
 *
 * This is a new flag rather than a new `reset_period` value because the
 * original CHECK constraint on `trackers.reset_period` can't be widened
 * without rebuilding the table (SQLite has no ALTER for CHECKs, and a rebuild
 * needs foreign keys off — impossible inside the runner's transaction).
 * A snapshot tracker keeps `reset_period = 'never'`; the flag overrides how
 * values aggregate.
 */
export const M004_SNAPSHOT_TRACKERS = {
  version: 4,
  name: '004_snapshot_trackers',
  up: /* sql */ `
    ALTER TABLE trackers
      ADD COLUMN is_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (is_snapshot IN (0, 1));
  `,
} as const;
