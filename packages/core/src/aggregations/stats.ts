import type { SqlParam, Storage } from '../storage/adapter.js';
import type { Clock } from '../time.js';
import type { Tracker } from '../schema/tables.js';
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
   * levels, not amounts, so they never add up).
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
    const entries = await this.storage.query<{ occurred_at: string; value: number }>(
      `SELECT occurred_at, value FROM ${source.sql}
        WHERE occurred_at >= ? AND occurred_at < ?
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
      whereSql = ' WHERE occurred_at >= ? AND occurred_at < ?';
      params.push(start, end);
    }
    const rows = await this.storage.query<{ total: number | null }>(
      `SELECT SUM(value) AS total FROM ${source.sql}${whereSql}`,
      params,
    );
    const current = rows[0]?.total ?? 0;

    return { target, current, ratio: ratioFor(target, current) };
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
