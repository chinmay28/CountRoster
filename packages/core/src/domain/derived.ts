import type { SqlParam, Storage } from '../storage/adapter.js';

/**
 * Thrown when a derivation is invalid — e.g. logging directly on a derived
 * tracker, or linking to a missing/derived/self source. Maps to HTTP 400.
 */
export class DerivedTrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivedTrackerError';
  }
}

/** True if the tracker exists and is flagged derived. */
export async function isDerivedTracker(
  storage: Storage,
  trackerId: string,
): Promise<boolean> {
  const rows = await storage.query<{ is_derived: number }>(
    `SELECT is_derived FROM trackers WHERE id = ?`,
    [trackerId],
  );
  return (rows[0]?.is_derived ?? 0) === 1;
}

/** A parenthesized subquery plus its bound parameters. */
export interface EntrySource {
  /** A `(SELECT …)` yielding id, tracker_id, value, occurred_at, created_at, updated_at. */
  sql: string;
  params: SqlParam[];
}

/**
 * Build the subquery that yields a tracker's *effective* entries.
 *
 * For an ordinary tracker this is just its own `entries`. For a derived
 * tracker it's a virtual stream: every source entry `(value v at time t)`
 * becomes a row of `coefficient × v` at `t`. Summing these rows over any range
 * therefore yields the weighted combination the derivation defines — which is
 * why every sum-based aggregation (totals, buckets, target progress, streaks)
 * works on a derived tracker without special-casing.
 *
 * Callers wrap this as `... FROM <source> WHERE …`; the returned params bind
 * first, before any range filters the caller appends.
 */
export async function effectiveEntrySource(
  storage: Storage,
  trackerId: string,
): Promise<EntrySource> {
  if (!(await isDerivedTracker(storage, trackerId))) {
    return {
      sql: `(SELECT id, tracker_id, value, occurred_at, created_at, updated_at
               FROM entries WHERE tracker_id = ?)`,
      params: [trackerId],
    };
  }
  return {
    sql: `(SELECT e.id AS id, ? AS tracker_id,
                  e.value * l.coefficient AS value,
                  e.occurred_at AS occurred_at,
                  e.created_at AS created_at,
                  e.updated_at AS updated_at
             FROM tracker_links l
             JOIN entries e ON e.tracker_id = l.source_id
            WHERE l.tracker_id = ?)`,
    params: [trackerId, trackerId],
  };
}
