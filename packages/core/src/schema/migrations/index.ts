import { M001_INITIAL } from './001_initial.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Ordered list of migrations. Append-only. NEVER edit an existing migration
 * once it's been shipped — write a new one.
 */
export const MIGRATIONS: readonly Migration[] = [M001_INITIAL] as const;

export const LATEST_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version;
