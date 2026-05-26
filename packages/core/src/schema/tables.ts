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
  created_at: string;
  updated_at: string;
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

export interface Reminder {
  id: string;
  tracker_id: string;
  /** Minutes since local midnight. */
  time_minute: number;
  /** Bitmask: bit 0 = Sunday ... bit 6 = Saturday. Default 127 = every day. */
  days_mask: number;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}
