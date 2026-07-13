/**
 * TypeScript types that mirror the SQL schema in migrations/001_initial.ts.
 * If the schema changes, update these and the Zod validators in lockstep.
 */

export type TrackerKind = 'count' | 'number' | 'duration' | 'boolean' | 'choice';

export type ResetPeriod = 'never' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** 0 = Sunday, 1 = Monday */
export type WeekStart = 0 | 1;

export interface Tracker {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  kind: TrackerKind;
  unit: string | null;
  target: number | null;
  reset_period: ResetPeriod;
  week_start: WeekStart;
  /** Minutes since local midnight when a "day" begins, e.g. 240 = 4:00 AM */
  day_start_minute: number;
  default_value: number;
  /** ISO 8601 timestamp, or null if active */
  archived_at: string | null;
  sort_order: number;
  /**
   * 1 if this tracker's value is computed from other trackers via
   * `tracker_links` (a "derived" tracker), 0 for an ordinary, logged tracker.
   * Derived trackers reject direct entry logging.
   */
  is_derived: 0 | 1;
  /**
   * 1 if this tracker is *hidden*: excluded from list() unless the caller
   * opts in with `includeHidden` (the UI only does so while the user has
   * unlocked hidden mode). Orthogonal to archiving. Derivations cannot mix
   * hidden and visible trackers.
   */
  is_hidden: 0 | 1;
  /**
   * 1 if this tracker records *snapshots* of a statistic (net worth, weight)
   * rather than amounts to add up. Entries don't accumulate: the current
   * value is the most recent entry, and aggregations take the last snapshot
   * in a period instead of the sum. Snapshot trackers keep
   * `reset_period = 'never'` — there is nothing to reset.
   */
  is_snapshot: 0 | 1;
  created_at: string;
  updated_at: string;
}

/**
 * One operand of a derived tracker: a source tracker and the coefficient its
 * values are multiplied by. A "Profit" tracker derived from Revenue (+1) and
 * Expenses (-1) has two links. The derived value over any range is the sum of
 * `coefficient × (source values in range)` across all links.
 */
export interface TrackerLink {
  id: string;
  /** The derived tracker this operand belongs to. */
  tracker_id: string;
  /** The source tracker whose entries feed the derivation. */
  source_id: string;
  /** Multiplier applied to the source's values (e.g. -1 to subtract). */
  coefficient: number;
  sort_order: number;
  created_at: string;
}

export interface TrackerOption {
  id: string;
  tracker_id: string;
  label: string;
  value: number;
  color: string | null;
  sort_order: number;
}

export interface Entry {
  id: string;
  tracker_id: string;
  value: number;
  /** When the thing being logged actually happened. */
  occurred_at: string;
  /** When the row was created (may differ from occurred_at if backdated). */
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  tracker_id: string;
  /** Optional link to a specific entry. NULL = a standalone note. */
  entry_id: string | null;
  body: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

/** One row per edit. The body shown is the current note; this captures what it WAS before that edit. */
export interface NoteEdit {
  id: string;
  note_id: string;
  prev_body: string;
  edited_at: string;
}

export interface TrackerGroup {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** Lifecycle of an imported credit-card transaction. */
export type TransactionStatus = 'pending' | 'confirmed' | 'ignored';

/**
 * One imported credit-card transaction, staged for review. `pending` rows
 * form the inbox; confirming files an Entry (value defaults to `-amount`,
 * spend-positive since bank exports carry debits as negatives) plus a Note
 * holding `name`, and links them via `entry_id`. Dismissed rows are kept as
 * `ignored` so `dedupe_key` still blocks re-importing the same CSV row.
 */
export interface CardTransaction {
  id: string;
  /** Local-noon ISO timestamp of the transaction's calendar date. */
  posted_at: string;
  /** As exported by the bank: debits negative, credits positive. */
  amount: number;
  /** Sanitized, user-editable display name — becomes the note body. */
  name: string;
  /** The untouched CSV descriptor (also what category rules key on). */
  raw_description: string;
  account: string | null;
  /** The aggregator's category column, used as a name-match fallback. */
  category: string | null;
  /** date|amount|description|account|ordinal — blocks re-import. */
  dedupe_key: string;
  status: TransactionStatus;
  /** Suggested (pending) or actual (confirmed) tracker. */
  tracker_id: string | null;
  /** The entry created on confirmation. */
  entry_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Learned auto-categorization: a normalized merchant key mapped to the
 * tracker its transactions belong in. Upserted on every confirmation.
 */
export interface CategoryRule {
  id: string;
  merchant: string;
  tracker_id: string;
  created_at: string;
  updated_at: string;
}

// NOTE: the `reminders` table still exists in the schema (migrations are
// append-only and old backups must round-trip), but the feature was removed —
// no service reads or writes it anymore.
