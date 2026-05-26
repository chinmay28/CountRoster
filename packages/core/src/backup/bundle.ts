import type { Storage } from '../storage/adapter.js';
import type { Manifest } from './manifest.js';

export interface ImportOptions {
  /** If false, refuse to import when the local DB is non-empty. */
  confirmOverwrite?: boolean;
}

export interface ImportResult {
  imported_rows: Record<string, number>;
  schema_version: number;
  /** Path/handle to the previous local DB snapshot (for rollback UX). */
  previous_slot: string | null;
}

export interface BackupService {
  /** Produce the full .countroster.zip as bytes. */
  exportBundle(): Promise<Uint8Array>;

  /** Produce the raw SQLite file as bytes. */
  exportSQLite(): Promise<Uint8Array>;

  /** Build (but don't write) the manifest describing the current DB. */
  buildManifest(opts: { app_version: string }): Promise<Manifest>;

  /** Replace the current DB with a bundle. */
  importBundle(bytes: Uint8Array, opts?: ImportOptions): Promise<ImportResult>;
}

export function createBackupService(_storage: Storage): BackupService {
  return {
    async exportBundle() {
      throw new Error('BackupService.exportBundle: not yet implemented');
    },
    async exportSQLite() {
      throw new Error('BackupService.exportSQLite: not yet implemented');
    },
    async buildManifest() {
      throw new Error('BackupService.buildManifest: not yet implemented');
    },
    async importBundle() {
      throw new Error('BackupService.importBundle: not yet implemented');
    },
  };
}
