import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Storage, SqlParam } from '@countroster/core';

/**
 * Storage adapter for the web shell, backed by @sqlite.org/sqlite-wasm.
 *
 * This is the concrete implementation of the reference sketch in
 * `packages/core/src/storage/sqlite-wasm.ts`. The core never imports
 * sqlite-wasm itself — SQL is the contract, and this adapter speaks it.
 *
 * Persistence:
 *   - When the page is cross-origin isolated, OPFS is available and the DB
 *     is durable across reloads (stored at a fixed OPFS path).
 *   - Otherwise we fall back to a transient in-memory DB so the app still
 *     boots (e.g. local file://, hosts without COOP/COEP). `persistent`
 *     reports which mode we ended up in so the UI can warn the user.
 *
 * The sqlite-wasm `oo1` API is synchronous, which maps cleanly onto core's
 * promise-returning Storage interface.
 */

// Minimal structural types for the bits of the sqlite-wasm oo1 API we touch.
// The package ships types, but they are loose (`any`-ish); these keep our
// call sites honest without pulling the whole surface in.
interface OoDb {
  exec(opts: {
    sql: string;
    bind?: readonly SqlParam[];
    rowMode?: 'object';
    returnValue?: 'resultRows';
    callback?: (row: Record<string, unknown>) => void;
  }): unknown;
  close(): void;
}

interface Sqlite3 {
  oo1: {
    DB: new (filename: string, flags: string) => OoDb;
    OpfsDb?: new (filename: string, flags: string) => OoDb;
  };
}

/** Fixed OPFS path for the local database. */
const OPFS_DB_PATH = '/countroster/app.sqlite';

let sqlite3Promise: Promise<Sqlite3> | null = null;

function loadSqlite3(): Promise<Sqlite3> {
  sqlite3Promise ??= sqlite3InitModule().then((m) => m as unknown as Sqlite3);
  return sqlite3Promise;
}

export class SQLiteWasmAdapter implements Storage {
  private readonly db: OoDb;

  /** True when backed by OPFS (durable); false for the in-memory fallback. */
  readonly persistent: boolean;

  private constructor(db: OoDb, persistent: boolean) {
    this.db = db;
    this.persistent = persistent;
  }

  /**
   * Open the database. Prefers an OPFS-backed connection; falls back to an
   * in-memory DB when OPFS is unavailable (e.g. not cross-origin isolated).
   */
  static async open(): Promise<SQLiteWasmAdapter> {
    const sqlite3 = await loadSqlite3();

    const canUseOpfs =
      typeof sqlite3.oo1.OpfsDb === 'function' &&
      // OPFS-backed VFS needs SharedArrayBuffer, which needs cross-origin isolation.
      typeof globalThis.crossOriginIsolated === 'boolean' &&
      globalThis.crossOriginIsolated;

    if (canUseOpfs && sqlite3.oo1.OpfsDb) {
      try {
        const db = new sqlite3.oo1.OpfsDb(OPFS_DB_PATH, 'c');
        const adapter = new SQLiteWasmAdapter(db, true);
        adapter.bootPragmas();
        return adapter;
      } catch (err) {
        // OPFS can throw at runtime (e.g. private-window quirks). Degrade
        // rather than failing to boot.
        console.warn(
          '[countroster] OPFS unavailable, using in-memory database. ' +
            'Data will not persist across reloads.',
          err,
        );
      }
    } else {
      console.warn(
        '[countroster] Page is not cross-origin isolated; using in-memory ' +
          'database. Data will not persist across reloads. See DEPLOYMENT.md.',
      );
    }

    const db = new sqlite3.oo1.DB(':memory:', 'c');
    const adapter = new SQLiteWasmAdapter(db, false);
    adapter.bootPragmas();
    return adapter;
  }

  private bootPragmas(): void {
    this.db.exec({ sql: 'PRAGMA foreign_keys = ON' });
  }

  async exec(sql: string, params: SqlParam[] = []): Promise<void> {
    this.db.exec(params.length === 0 ? { sql } : { sql, bind: params });
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T[]> {
    const rows: Record<string, unknown>[] = [];
    this.db.exec({
      sql,
      ...(params.length > 0 ? { bind: params } : {}),
      rowMode: 'object',
      callback: (row) => {
        rows.push(row);
      },
    });
    return rows as T[];
  }

  async transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T> {
    this.db.exec({ sql: 'BEGIN' });
    try {
      // The sqlite-wasm connection has no separate nested-transaction handle;
      // operations on `this` run inside the BEGIN we just opened.
      const result = await fn(this);
      this.db.exec({ sql: 'COMMIT' });
      return result;
    } catch (err) {
      this.db.exec({ sql: 'ROLLBACK' });
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
