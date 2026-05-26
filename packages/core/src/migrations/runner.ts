import type { Storage } from '../storage/adapter.js';
import { MIGRATIONS, LATEST_VERSION, type Migration } from '../schema/migrations/index.js';

const SCHEMA_VERSION_KEY = 'schema_version';

export interface MigrationRunner {
  /** Apply any pending migrations. Returns the schema version after running. */
  run(): Promise<number>;
  /** Current schema_version stored in app_meta, or 0 if not yet initialized. */
  currentVersion(): Promise<number>;
  /** The highest version known to this build. */
  latestVersion(): number;
}

export function createMigrationRunner(storage: Storage): MigrationRunner {
  return new MigrationRunnerImpl(storage);
}

class MigrationRunnerImpl implements MigrationRunner {
  constructor(private readonly storage: Storage) {}

  latestVersion(): number {
    return LATEST_VERSION;
  }

  async currentVersion(): Promise<number> {
    // app_meta itself may not exist yet on a fresh DB.
    const tables = await this.storage.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'`,
    );
    if (tables.length === 0) return 0;

    const rows = await this.storage.query<{ value: string }>(
      `SELECT value FROM app_meta WHERE key = ?`,
      [SCHEMA_VERSION_KEY],
    );
    if (rows.length === 0) return 0;
    const v = Number.parseInt(rows[0]!.value, 10);
    return Number.isFinite(v) ? v : 0;
  }

  async run(): Promise<number> {
    const current = await this.currentVersion();
    const pending = MIGRATIONS.filter((m) => m.version > current);
    if (pending.length === 0) return current;

    return this.storage.transaction(async (tx) => {
      for (const m of pending) {
        await applyMigration(tx, m);
      }
      const newVersion = pending[pending.length - 1]!.version;
      await tx.exec(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SCHEMA_VERSION_KEY, String(newVersion)],
      );
      return newVersion;
    });
  }
}

async function applyMigration(tx: Storage, m: Migration): Promise<void> {
  await tx.exec(m.up);
}
