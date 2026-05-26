import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Storage, SqlParam } from './adapter.js';

/**
 * A Storage implementation backed by `node:sqlite` (built into Node 22+).
 *
 * Used by the Vitest suite (against `:memory:`) and by a future countroster-cli
 * (against a file path). Not bundled into mobile or web builds, which use
 * their own SQLite engines (expo-sqlite / sqlite-wasm).
 *
 * Why node:sqlite over better-sqlite3?
 *   - Zero native compilation; no install-time toolchain needed.
 *   - Built in; one less moving part.
 *   - Sync API is identical in shape to better-sqlite3, so swapping is trivial
 *     if `node:sqlite`'s experimental status becomes a problem.
 *
 * Loading detail: we use `process.getBuiltinModule()` rather than a static
 * `import` to sidestep bundlers (notably Vite/Vitest) whose resolvers predate
 * Node 22's built-in SQLite and choke on `node:sqlite`. The `import type` is
 * compile-time only and is erased before any bundler sees it.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

type NodeSqliteParam = string | number | bigint | Uint8Array | null;

export class MemoryAdapter implements Storage {
  private readonly db: DatabaseSyncType;
  private readonly inTransaction: boolean;

  private constructor(db: DatabaseSyncType, inTransaction = false) {
    this.db = db;
    this.inTransaction = inTransaction;
  }

  static open(path: string = ':memory:'): MemoryAdapter {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    return new MemoryAdapter(db);
  }

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    if (params.length === 0) {
      // Allows multi-statement SQL (used by migrations).
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...this.bind(params));
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }
    this.db.exec('BEGIN');
    try {
      const tx = new MemoryAdapter(this.db, true);
      const result = await fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private bind(params: SqlParam[]): NodeSqliteParam[] {
    return params;
  }
}
