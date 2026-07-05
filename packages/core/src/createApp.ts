import type { Storage } from './storage/adapter.js';
import { systemClock, type Clock } from './time.js';
import { createMigrationRunner, type MigrationRunner } from './migrations/runner.js';
import { createTrackerService, type TrackerService } from './domain/trackers.js';
import { createEntryService, type EntryService } from './domain/entries.js';
import { createNoteService, type NoteService } from './domain/notes.js';
import { createGroupService, type GroupService } from './domain/groups.js';
import { createStatsService, type StatsService } from './aggregations/stats.js';
import { createBackupService, type BackupService } from './backup/bundle.js';

/**
 * The fully constructed core. Compose one of these once at app startup,
 * after the storage adapter has been opened and migrations have run.
 */
export interface CountRosterCore {
  trackers: TrackerService;
  entries: EntryService;
  notes: NoteService;
  groups: GroupService;
  stats: StatsService;
  backup: BackupService;
  migrations: MigrationRunner;
}

export interface CreateAppOptions {
  /** Override the system clock — primarily for tests. */
  clock?: Clock;
}

export function createApp(
  storage: Storage,
  opts: CreateAppOptions = {},
): CountRosterCore {
  const clock = opts.clock ?? systemClock;

  return {
    trackers: createTrackerService(storage, clock),
    entries: createEntryService(storage, clock),
    notes: createNoteService(storage, clock),
    groups: createGroupService(storage, clock),
    stats: createStatsService(storage, clock),
    backup: createBackupService(storage, clock),
    migrations: createMigrationRunner(storage),
  };
}
