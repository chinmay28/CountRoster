import { M001_INITIAL } from './001_initial.js';
import { M002_DERIVED_TRACKERS } from './002_derived_trackers.js';
import { M003_HIDDEN_TRACKERS } from './003_hidden_trackers.js';
import { M004_SNAPSHOT_TRACKERS } from './004_snapshot_trackers.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Ordered list of migrations. Append-only. NEVER edit an existing migration
 * once it's been shipped — write a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
  M001_INITIAL,
  M002_DERIVED_TRACKERS,
  M003_HIDDEN_TRACKERS,
  M004_SNAPSHOT_TRACKERS,
] as const;

export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;
