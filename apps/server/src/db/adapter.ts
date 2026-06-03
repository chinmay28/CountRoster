import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { Storage, SqlParam } from '@countroster/core';

/**
 * Server-side Storage adapter backed by `node:sqlite` (built into Node 22+),
 * writing to a single SQLite file on disk. This file is the one shared source
 * of truth that every client reads and writes through the REST API.
 *
 * It mirrors the test `MemoryAdapter` in `@countroster/core` — the same engine,
 * just file-backed instead of `:memory:`. Per the architecture, each platform
 * shell owns its storage engine; this is the server's.
 *
 * `process.getBuiltinModule('node:sqlite')` is used instead of a static import
 * so tooling that predates Node 22's built-in SQLite doesn't choke resolving it.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export class NodeSqliteAdapter implements Storage {
  private readonly db: DatabaseSyncType;
  private readonly inTransaction: boolean;
  /** The on-disk path of this database (':memory:' for the transient case). */
  readonly path: string;

  private constructor(
    db: DatabaseSyncType,
    path: string,
    inTransaction = false,
  ) {
    this.db = db;
    this.path = path;
    this.inTransaction = inTransaction;
  }

  static open(path: string): NodeSqliteAdapter {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    return new NodeSqliteAdapter(db, path);
  }

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    if (params.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...params);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }
    this.db.exec('BEGIN');
    try {
      const tx = new NodeSqliteAdapter(this.db, this.path, true);
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
}
