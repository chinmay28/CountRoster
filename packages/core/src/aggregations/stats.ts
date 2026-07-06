import type { SqlParam, Storage } from '../storage/adapter.js';
import type { Clock } from '../time.js';
import type { Tracker } from '../schema/tables.js';
import type { TimeRange } from '../domain/entries.js';
import { effectiveEntrySource } from '../domain/derived.js';
import {
  bucketStart,
  bucketEnd,
  bucketLabel,
  type Bucket,
  type BucketPeriod,
} from './periods.js';

/** A period bucket with its aggregated value. */
export interface StatBucket extends Bucket {
  /**
   * Sum of entry values that fall in this bucket — or, for a snapshot
   * tracker, the value of the *last* entry in the bucket (snapshots record
   * levels, not amounts, so they never add up); a snapshot bucket with no
   * entries carries the last known level forward, count 0.
   */
  value: number;
  /** Number of entries in this bucket. */
  count: number;
}

export interface TargetProgress {
  target: number | null;
  current: number;
  /** `current / target`, clamped to [0, 1]; null if no target. */
  ratio: number | null;
}

/** One source operand's contribution to a derived tracker's total. */
export interface CompositionSlice {
  source_id: string;
  /** The source tracker's display name and color, for charting. */
  name: string;
  color: string;
  coefficient: number;
  /**
   * `coefficient × SUM(source entry values)` over the requested range — or,
   * for a derived *snapshot* tracker, `coefficient × the source's latest
   * reading` as of the range's end (levels don't sum; a source with no
   * reading in the range carries its last earlier one).
   */
  total: number;
  /** Number of source entries in the range (0 for a carried-over level). */
  count: number;
}

export interface StatsService {
  /** Sum entry values into period buckets spanning [range.start, range.end). */
  bucket(
    trackerId: string,
    range: { start: string; end: string },
    period: BucketPeriod,
  ): Promise<StatBucket[]>;

  /** Consecutive-day logging streak: current run and longest ever. */
  streak(trackerId: string): Promise<{ current: number; longest: number }>;

  /** Progress toward the tracker's target within its current reset period. */
  targetProgress(trackerId: string, at?: string): Promise<TargetProgress>;

  /**
   * How a derived tracker's total splits across its source operands, one
   * slice per link in derivation order — all time by default, or scoped to
   * `range` (e.g. one reset window). For a derived snapshot tracker the
   * slices are the sources' levels as of the range's end (see
   * CompositionSlice.total). Empty for an ordinary tracker.
   */
  composition(trackerId: string, range?: TimeRange): Promise<CompositionSlice[]>;
}

export function createStatsService(
  storage: Storage,
  clock: Clock,
): StatsService {
  return new StatsServiceImpl(storage, clock);
}

class StatsServiceImpl implements StatsService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  private async getTracker(trackerId: string): Promise<Tracker | null> {
    const rows = await this.storage.query<Tracker>(
      `SELECT * FROM trackers WHERE id = ?`,
      [trackerId],
    );
    return rows[0] ?? null;
  }

  async bucket(
    trackerId: string,
    range: { start: string; end: string },
    period: BucketPeriod,
  ): Promise<StatBucket[]> {
    const tracker = await this.getTracker(trackerId);
    const weekStart = tracker?.week_start ?? 1;
    const isSnapshot = tracker?.is_snapshot === 1;

    const source = await effectiveEntrySource(this.storage, trackerId);
    // Compare by absolute instant (julianday), not lexically: occurred_at is
    // stored with the server's local offset while the range bounds may arrive
    // in a different offset (see EntryService.forTracker).
    const entries = await this.storage.query<{ occurred_at: string; value: number }>(
      `SELECT occurred_at, value FROM ${source.sql}
        WHERE julianday(occurred_at) >= julianday(?)
          AND julianday(occurred_at) < julianday(?)
        ORDER BY occurred_at ASC`,
      [...source.params, range.start, range.end],
    );

    // Pre-build the empty buckets spanning the range so gaps show as zeroes.
    const buckets: StatBucket[] = [];
    const index = new Map<string, StatBucket>();
    const rangeEnd = new Date(range.end);
    let cursor = bucketStart(new Date(range.start), period, weekStart);
    while (cursor < rangeEnd) {
      const end = bucketEnd(cursor, period, weekStart);
      const b: StatBucket = {
        start: cursor.toISOString(),
        end: end.toISOString(),
        label: bucketLabel(cursor, period),
        value: 0,
        count: 0,
      };
      buckets.push(b);
      index.set(b.label, b);
      cursor = end;
    }

    for (const e of entries) {
      const label = bucketLabel(
        bucketStart(new Date(e.occurred_at), period, weekStart),
        period,
      );
      const b = index.get(label);
      if (b) {
        // Snapshots are levels, not amounts: the bucket takes the latest
        // reading (entries arrive in occurred_at order) instead of a sum.
        b.value = isSnapshot ? e.value : b.value + e.value;
        b.count += 1;
      }
    }

    if (isSnapshot) {
      // A level persists between readings, so a bucket without one holds the
      // last known level instead of dropping to zero (its count stays 0).
      // Seed from the latest reading before the range so the leading buckets
      // carry too; before the first-ever reading there is nothing to carry.
      const prior = await this.storage.query<{ value: number }>(
        `SELECT value FROM ${source.sql}
          WHERE julianday(occurred_at) < julianday(?)
          ORDER BY julianday(occurred_at) DESC, id DESC LIMIT 1`,
        [...source.params, range.start],
      );
      let carry: number | null = prior[0]?.value ?? null;
      for (const b of buckets) {
        if (b.count > 0) carry = b.value;
        else if (carry !== null) b.value = carry;
      }
    }

    return buckets;
  }

  async streak(trackerId: string): Promise<{ current: number; longest: number }> {
    const source = await effectiveEntrySource(this.storage, trackerId);
    const rows = await this.storage.query<{ occurred_at: string }>(
      `SELECT DISTINCT substr(occurred_at, 1, 10) AS occurred_at
         FROM ${source.sql}
        ORDER BY occurred_at ASC`,
      source.params,
    );
    const days = rows.map((r) => r.occurred_at);
    if (days.length === 0) return { current: 0, longest: 0 };

    const present = new Set(days);

    // Longest run of consecutive calendar days.
    let longest = 1;
    let run = 1;
    for (let i = 1; i < days.length; i++) {
      if (isNextDay(days[i - 1]!, days[i]!)) {
        run += 1;
      } else {
        run = 1;
      }
      if (run > longest) longest = run;
    }

    // Current run: walk back from today (or yesterday, if today isn't logged yet).
    const today = this.clock.nowISO().slice(0, 10);
    let anchor: string | null = null;
    if (present.has(today)) anchor = today;
    else if (present.has(addDays(today, -1))) anchor = addDays(today, -1);

    let current = 0;
    if (anchor) {
      let day = anchor;
      while (present.has(day)) {
        current += 1;
        day = addDays(day, -1);
      }
    }

    return { current, longest };
  }

  async targetProgress(trackerId: string, at?: string): Promise<TargetProgress> {
    const tracker = await this.getTracker(trackerId);
    if (!tracker) return { target: null, current: 0, ratio: null };

    const target = tracker.target;
    const instant = new Date(at ?? this.clock.nowISO());

    const source = await effectiveEntrySource(this.storage, trackerId);

    // A snapshot tracker's "current" is its most recent reading — there is
    // no window to sum over.
    if (tracker.is_snapshot === 1) {
      const rows = await this.storage.query<{ value: number }>(
        `SELECT value FROM ${source.sql}
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        source.params,
      );
      const current = rows[0]?.value ?? 0;
      return { target, current, ratio: ratioFor(target, current) };
    }

    let start: string | null = null;
    let end: string | null = null;
    if (tracker.reset_period !== 'never') {
      const period = RESET_TO_PERIOD[tracker.reset_period];
      start = bucketStart(instant, period, tracker.week_start).toISOString();
      end = bucketEnd(instant, period, tracker.week_start).toISOString();
    }

    const params: SqlParam[] = [...source.params];
    let whereSql = '';
    if (start !== null && end !== null) {
      // Instant-based bounds: the window edges are UTC ("Z") strings while
      // occurred_at carries a local offset, so lexical compare would misplace
      // entries near the window edges (see EntryService.forTracker).
      whereSql =
        ' WHERE julianday(occurred_at) >= julianday(?)' +
        ' AND julianday(occurred_at) < julianday(?)';
      params.push(start, end);
    }
    const rows = await this.storage.query<{ total: number | null }>(
      `SELECT SUM(value) AS total FROM ${source.sql}${whereSql}`,
      params,
    );
    const current = rows[0]?.total ?? 0;

    return { target, current, ratio: ratioFor(target, current) };
  }

  async composition(
    trackerId: string,
    range: TimeRange = {},
  ): Promise<CompositionSlice[]> {
    const tracker = await this.getTracker(trackerId);
    if (tracker?.is_snapshot === 1) return this.snapshotComposition(trackerId, range);

    // One row per link: the source's identity plus its weighted entry sum.
    // LEFT JOIN keeps sources with no entries in range (a 0-total slice,
    // count 0), which is why the range filter lives in the ON clause — in a
    // WHERE it would drop those rows. Bounds compare by absolute instant
    // (julianday), matching EntryService.forTracker: occurred_at carries the
    // *server's* offset while a client may ask in a different one.
    const on: string[] = ['e.tracker_id = l.source_id'];
    const params: SqlParam[] = [];
    if (range.start !== undefined) {
      on.push('julianday(e.occurred_at) >= julianday(?)');
      params.push(range.start);
    }
    if (range.end !== undefined) {
      on.push('julianday(e.occurred_at) < julianday(?)');
      params.push(range.end);
    }
    return this.storage.query<CompositionSlice>(
      `SELECT l.source_id AS source_id,
              s.name AS name,
              s.color AS color,
              l.coefficient AS coefficient,
              COALESCE(l.coefficient * SUM(e.value), 0) AS total,
              COUNT(e.id) AS count
         FROM tracker_links l
         JOIN trackers s ON s.id = l.source_id
         LEFT JOIN entries e ON ${on.join(' AND ')}
        WHERE l.tracker_id = ?
        GROUP BY l.id
        ORDER BY l.sort_order ASC, l.created_at ASC`,
      [...params, trackerId],
    );
  }

  /**
   * Composition of a derived *snapshot* tracker: levels don't sum over a
   * range, so each slice is `coefficient × the source's latest reading`
   * strictly before the range's end (as of now when unbounded). The range's
   * start only scopes `count` — a source that logged nothing in the window
   * still carries its last earlier reading, best effort, so a partial month
   * of data still composes into a full picture.
   */
  private async snapshotComposition(
    trackerId: string,
    range: TimeRange,
  ): Promise<CompositionSlice[]> {
    const levelWhere: string[] = ['e.tracker_id = l.source_id'];
    const countWhere: string[] = ['e.tracker_id = l.source_id'];
    const params: SqlParam[] = [];
    if (range.end !== undefined) {
      levelWhere.push('julianday(e.occurred_at) < julianday(?)');
      params.push(range.end);
    }
    if (range.start !== undefined) {
      countWhere.push('julianday(e.occurred_at) >= julianday(?)');
      params.push(range.start);
    }
    if (range.end !== undefined) {
      countWhere.push('julianday(e.occurred_at) < julianday(?)');
      params.push(range.end);
    }
    return this.storage.query<CompositionSlice>(
      `SELECT l.source_id AS source_id,
              s.name AS name,
              s.color AS color,
              l.coefficient AS coefficient,
              COALESCE(l.coefficient * (
                SELECT e.value FROM entries e
                 WHERE ${levelWhere.join(' AND ')}
                 ORDER BY julianday(e.occurred_at) DESC, e.id DESC LIMIT 1
              ), 0) AS total,
              (SELECT COUNT(*) FROM entries e
                WHERE ${countWhere.join(' AND ')}) AS count
         FROM tracker_links l
         JOIN trackers s ON s.id = l.source_id
        WHERE l.tracker_id = ?
        ORDER BY l.sort_order ASC, l.created_at ASC`,
      [...params, trackerId],
    );
  }
}

/** `current / target`, clamped to [0, 1]; null when there is no usable target. */
function ratioFor(target: number | null, current: number): number | null {
  return target != null && target !== 0
    ? Math.max(0, Math.min(1, current / target))
    : null;
}

const RESET_TO_PERIOD: Record<
  Exclude<Tracker['reset_period'], 'never'>,
  BucketPeriod
> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

/** True if `b` (YYYY-MM-DD) is the calendar day immediately after `a`. */
function isNextDay(a: string, b: string): boolean {
  return addDays(a, 1) === b;
}

/** Add `delta` days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
