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
  /**
   * Day-of-month a monthly window opens on, 1..28 — 8 means a month runs the
   * 8th through the 7th of the next month. Capped at 28 so every month has
   * the day. Also the day-of-month a yearly window opens on.
   */
  month_start_day: number;
  /**
   * Month a yearly window opens on, 1..12 — 4 gives a fiscal year running
   * April through March. The window opens on `month_start_day` of it.
   */
  year_start_month: number;
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
  /**
   * The user's preferred order for the detail page's sections: a
   * comma-separated list of section keys ("summary,trends,log,entries,notes"),
   * or null for the default order. The keys are opaque to the domain — which
   * sections exist is the client's business, so a client ignores keys it
   * doesn't know and appends the sections the list omits.
   */
  section_order: string | null;
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

/**
 * What a custom field captures. `choice` picks one of the field's options,
 * `flag` is a yes/no toggle, `number` an extra measurement, `text` a short
 * free-form label.
 */
export type TrackerFieldKind = 'choice' | 'flag' | 'number' | 'text';

/**
 * One piece of custom data a tracker records alongside each entry's primary
 * value. A milk-feeding tracker counts millilitres and carries a "Feed type"
 * choice field ("bottle / formula / breast") plus a "Wet diaper" flag, so the
 * same volume can be broken down by either without splitting the tracker.
 */
export interface TrackerField {
  id: string;
  tracker_id: string;
  name: string;
  kind: TrackerFieldKind;
  unit: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /**
   * The alternatives of a `choice` field, in order — empty for every other
   * kind. A join rather than a column, but always present so callers never
   * have to check for a missing key.
   */
  options: TrackerFieldOption[];
}

/** One alternative of a `choice` field. */
export interface TrackerFieldOption {
  id: string;
  field_id: string;
  label: string;
  color: string | null;
  sort_order: number;
}

/**
 * One entry's answer to one field. Which column carries it follows the field's
 * kind: choice → option_id, flag/number → number_value (0|1 for a flag),
 * text → text_value. The other two are null.
 */
export interface EntryFieldValue {
  id: string;
  entry_id: string;
  field_id: string;
  option_id: string | null;
  number_value: number | null;
  text_value: string | null;
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
  /**
   * This entry's custom-field answers, ordered by the owning field's
   * sort_order. Always an array — `[]` for a tracker that defines no fields.
   */
  fields: EntryFieldValue[];
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

/** Cloud destinations the automatic backup can upload to (migration 009). */
export type CloudProvider = 'dropbox' | 'google_drive';

/** How often the server exports a bundle to the connected cloud folder. */
export type CloudBackupFrequency =
  | 'off'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly';

/**
 * The single `cloud_backup_settings` row (`id = 'singleton'`): which cloud
 * account the server may write to, the folder chosen inside it, the schedule,
 * and the outcome of the last run.
 *
 * Written only by the Go server, which owns the OAuth exchange and the
 * uploads — the TS core carries the type (and migration 009) so both
 * implementations produce identical databases. The row is **not** part of the
 * backup bundle: it holds credentials, and a restore must not repoint a
 * server at some other machine's cloud account.
 */
export interface CloudBackupSettings {
  id: 'singleton';
  provider: CloudProvider | null;
  /** Display name of the connected account, e.g. an email address. */
  account_label: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  /** Provider-native folder handle: a Drive file id, a Dropbox path. */
  folder_id: string | null;
  /** Human-readable path of that folder, for the UI. */
  folder_path: string | null;
  frequency: CloudBackupFrequency;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_file_name: string | null;
  updated_at: string | null;
}
