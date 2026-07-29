import { M001_INITIAL } from './001_initial.js';
import { M002_DERIVED_TRACKERS } from './002_derived_trackers.js';
import { M003_HIDDEN_TRACKERS } from './003_hidden_trackers.js';
import { M004_SNAPSHOT_TRACKERS } from './004_snapshot_trackers.js';
import { M005_CARD_TRANSACTIONS } from './005_card_transactions.js';
import { M006_PERIOD_WINDOWS } from './006_period_windows.js';
import { M007_TRACKER_FIELDS } from './007_tracker_fields.js';
import { M008_SECTION_ORDER } from './008_section_order.js';
import { M009_CLOUD_BACKUP } from './009_cloud_backup.js';

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
  M005_CARD_TRANSACTIONS,
  M006_PERIOD_WINDOWS,
  M007_TRACKER_FIELDS,
  M008_SECTION_ORDER,
  M009_CLOUD_BACKUP,
] as const;

export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;
