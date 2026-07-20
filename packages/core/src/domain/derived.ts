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
 * A derived *snapshot* tracker combines levels, not amounts, so its stream is
 * different: each *day* with a source reading becomes a *single* row whose
 * value is the *combined level* as of that day — Σ coefficient × (that source's
 * latest reading at or before it). A source with no reading yet simply
 * contributes nothing (best effort), and one that skipped a period carries its
 * previous reading forward. Updating the sources one at a time (each a distinct
 * instant, seconds/minutes apart) would otherwise emit a row per touch — each a
 * partial level while the other sources are momentarily stale — so only the
 * last reading of each day survives, its combined level already settled. The
 * latest row is therefore the current combined level, and a line through the
 * rows is the level-over-time chart, one point per day you recorded it.
 *
 * Callers wrap this as `... FROM <source> WHERE …`; the returned params bind
 * first, before any range filters the caller appends.
 */
export async function effectiveEntrySource(
  storage: Storage,
  trackerId: string,
): Promise<EntrySource> {
  const rows = await storage.query<{ is_derived: number; is_snapshot: number }>(
    `SELECT is_derived, is_snapshot FROM trackers WHERE id = ?`,
    [trackerId],
  );
  const tracker = rows[0];
  if ((tracker?.is_derived ?? 0) !== 1) {
    return {
      sql: `(SELECT id, tracker_id, value, occurred_at, created_at, updated_at
               FROM entries WHERE tracker_id = ?)`,
      params: [trackerId],
    };
  }
  if (tracker!.is_snapshot === 1) {
    // Instants compare by julianday, not lexically, because occurred_at may
    // carry mixed offsets; simultaneous readings tie-break on id (UUIDv7,
    // time-sortable). SUM skips a NULL operand — a source with no reading at
    // or before the row's instant — which is what carries partial data.
    //
    // The NOT EXISTS collapses each day to one point: it keeps only the last
    // reading of each local day (`substr` is the stored local date), and that
    // row's SUM already folds in every earlier reading via carry-forward, so
    // its value is the day's settled combined level. Dropping the rest is what
    // plots one composite value per day instead of one per source touch.
    return {
      sql: `(SELECT e.id AS id, ? AS tracker_id,
                    (SELECT SUM(l2.coefficient * (
                       SELECT e2.value FROM entries e2
                        WHERE e2.tracker_id = l2.source_id
                          AND (julianday(e2.occurred_at) < julianday(e.occurred_at)
                               OR (julianday(e2.occurred_at) = julianday(e.occurred_at)
                                   AND e2.id <= e.id))
                        ORDER BY julianday(e2.occurred_at) DESC, e2.id DESC
                        LIMIT 1))
                       FROM tracker_links l2
                      WHERE l2.tracker_id = ?) AS value,
                    e.occurred_at AS occurred_at,
                    e.created_at AS created_at,
                    e.updated_at AS updated_at
               FROM tracker_links l
               JOIN entries e ON e.tracker_id = l.source_id
              WHERE l.tracker_id = ?
                AND NOT EXISTS (
                      SELECT 1 FROM tracker_links l3
                       JOIN entries e3 ON e3.tracker_id = l3.source_id
                      WHERE l3.tracker_id = ?
                        AND substr(e3.occurred_at, 1, 10) = substr(e.occurred_at, 1, 10)
                        AND (julianday(e3.occurred_at) > julianday(e.occurred_at)
                             OR (julianday(e3.occurred_at) = julianday(e.occurred_at)
                                 AND e3.id > e.id))))`,
      params: [trackerId, trackerId, trackerId, trackerId],
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
