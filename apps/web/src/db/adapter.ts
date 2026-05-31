import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Storage, SqlParam } from '@countroster/core';

/**
 * Storage adapter for the web/mobile-webview shell, backed by
 * @sqlite.org/sqlite-wasm.
 *
 * This is the concrete implementation of the reference sketch in
 * `packages/core/src/storage/sqlite-wasm.ts`. The core never imports
 * sqlite-wasm itself — SQL is the contract, and this adapter speaks it.
 *
 * Persistence uses the **OPFS SAHPool VFS** (`installOpfsSAHPoolVfs`):
 *   - It persists to the Origin Private File System via synchronous access
 *     handles and, crucially, does NOT require cross-origin isolation
 *     (no COOP/COEP, no SharedArrayBuffer). That makes it work on plain
 *     static hosts, over a LAN/Tailscale URL, and — the reason it matters
 *     here — inside a Capacitor WKWebView on iOS, which serves from a
 *     custom scheme that is never cross-origin isolated.
 *   - When OPFS is unavailable (older iOS/Safari, or a context without
 *     storage access) we fall back to a transient in-memory DB so the app
 *     still boots. `persistent` reports which mode we ended up in so the UI
 *     can warn the user.
 *
 * The sqlite-wasm `oo1` API is synchronous, which maps cleanly onto core's
 * promise-returning Storage interface.
 */

// Minimal structural types for the bits of the sqlite-wasm API we touch.
// The package ships types, but they are heavily overloaded; these keep our
// call sites honest without wrestling a dozen `exec` signatures under
// `exactOptionalPropertyTypes`.
interface OoDb {
  exec(opts: {
    sql: string;
    bind?: readonly SqlParam[];
    rowMode?: 'object';
    callback?: (row: Record<string, unknown>) => void;
  }): unknown;
  close(): void;
}

interface SAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => OoDb;
}

interface Sqlite3 {
  oo1: {
    DB: new (filename: string, flags: string) => OoDb;
  };
  installOpfsSAHPoolVfs?: (opts: {
    name?: string;
    directory?: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
  }) => Promise<SAHPoolUtil>;
}

/** Filename of the database within the SAHPool VFS. */
const DB_FILENAME = '/countroster.sqlite';

/** OPFS directory the SAHPool VFS owns (it manages all files within it). */
const SAHPOOL_DIR = '.countroster-sahpool';

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
   * Open the database. Prefers the OPFS SAHPool (durable, no isolation
   * required); falls back to an in-memory DB when OPFS is unavailable.
   */
  static async open(): Promise<SQLiteWasmAdapter> {
    const sqlite3 = await loadSqlite3();

    if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({
          name: 'countroster',
          directory: SAHPOOL_DIR,
        });
        const db = new pool.OpfsSAHPoolDb(DB_FILENAME);
        const adapter = new SQLiteWasmAdapter(db, true);
        adapter.bootPragmas();
        return adapter;
      } catch (err) {
        // OPFS can be missing (old iOS/Safari) or throw at runtime (private
        // windows, no storage access). Degrade rather than failing to boot.
        console.warn(
          '[countroster] OPFS persistence unavailable; using an in-memory ' +
            'database. Data will not survive a reload. See apps/web/README.md.',
          err,
        );
      }
    } else {
      console.warn(
        '[countroster] sqlite-wasm OPFS SAHPool VFS not present; using an ' +
          'in-memory database. Data will not survive a reload.',
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
