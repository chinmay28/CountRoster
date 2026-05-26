/**
 * Storage is the contract between the domain layer and whatever SQLite engine
 * the platform provides. It is intentionally tiny:
 *
 *   - exec()        — fire-and-forget DDL/DML
 *   - query<T>()    — return rows
 *   - transaction() — atomic group of operations
 *   - close()       — release resources
 *
 * Three implementations exist (or will):
 *   - @countroster/core/testing  → MemoryAdapter (better-sqlite3 :memory:)
 *   - apps/mobile          → SQLiteExpoAdapter (expo-sqlite)
 *   - apps/web             → SQLiteWasmAdapter (sqlite-wasm + OPFS)
 *
 * Domain services write raw SQL. The adapter does not parse or rewrite it.
 * SQL *is* the contract.
 */

export type SqlParam = string | number | null | bigint | Uint8Array;

export interface Storage {
  /** Execute a statement that does not return rows. */
  exec(sql: string, params?: SqlParam[]): Promise<void>;

  /** Execute a query and return all matching rows. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: SqlParam[],
  ): Promise<T[]>;

  /**
   * Run `fn` in a transaction. If `fn` throws, the transaction is rolled back
   * and the error is re-thrown. Nested transactions are not supported (the
   * inner `fn` simply runs in the outer transaction).
   */
  transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;

  /** Release the underlying connection / file handle. */
  close(): Promise<void>;
}
