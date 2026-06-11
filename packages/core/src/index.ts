// Composition root
export { createApp, type CountRosterCore, type CreateAppOptions } from './createApp.js';

// Storage contract (platform shells implement this)
export type { Storage, SqlParam } from './storage/adapter.js';

// Time (so platforms can supply their own clock if needed)
export { systemClock, fixedClock, toLocalISO, type Clock } from './time.js';

// Schema types
export type {
  Tracker,
  TrackerKind,
  TrackerOption,
  TrackerLink,
  ResetPeriod,
  WeekStart,
  Entry,
  Note,
  NoteEdit,
  TrackerGroup,
  Reminder,
} from './schema/tables.js';

// Input shapes
export {
  trackerInputSchema,
  trackerPatchSchema,
  trackerLinkInputSchema,
  entryLogInputSchema,
  entryPatchSchema,
  noteInputSchema,
  notePatchSchema,
  groupInputSchema,
  groupPatchSchema,
  reminderInputSchema,
  reminderPatchSchema,
  type TrackerInput,
  type TrackerPatch,
  type TrackerLinkInput,
  type EntryLogInput,
  type EntryPatch,
  type NoteInput,
  type NotePatch,
  type GroupInput,
  type GroupPatch,
  type ReminderInput,
  type ReminderPatch,
} from './schema/validators.js';

// Services
export {
  type TrackerService,
  TrackerNotFoundError,
  TrackerInUseError,
} from './domain/trackers.js';
export { DerivedTrackerError } from './domain/derived.js';
export {
  type EntryService,
  type TimeRange,
  EntryNotFoundError,
} from './domain/entries.js';
export {
  type NoteService,
  NoteNotFoundError,
} from './domain/notes.js';
export {
  type GroupService,
  GroupNotFoundError,
} from './domain/groups.js';
export {
  type ReminderService,
  ReminderNotFoundError,
} from './domain/reminders.js';
export type {
  StatsService,
  StatBucket,
  TargetProgress,
} from './aggregations/stats.js';

// Aggregation primitives
export type { Bucket, BucketPeriod } from './aggregations/periods.js';
export {
  bucketStart,
  bucketEnd,
  bucketLabel,
} from './aggregations/periods.js';

// Backup
export type {
  BackupService,
  ImportOptions,
  ImportResult,
} from './backup/bundle.js';
export { manifestSchema, type Manifest } from './backup/manifest.js';

// Migrations
export type { MigrationRunner } from './migrations/runner.js';
export { LATEST_VERSION } from './schema/migrations/index.js';
