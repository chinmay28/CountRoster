/**
 * Storage adapter for @sqlite.org/sqlite-wasm (web). Implemented in apps/web
 * with the OPFS-backed VFS.
 *
 * Reference shape (do not import sqlite-wasm here):
 *
 *   import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
 *
 *   export class SQLiteWasmAdapter implements Storage {
 *     private db: any; // sqlite3.oo1.OpfsDb
 *     static async open(filename: string): Promise<SQLiteWasmAdapter> {
 *       const sqlite3 = await sqlite3InitModule();
 *       const db = new sqlite3.oo1.OpfsDb(filename, 'c');
 *       db.exec('PRAGMA foreign_keys = ON');
 *       return new SQLiteWasmAdapter(db);
 *     }
 *     async exec(sql, params = []) {
 *       this.db.exec({ sql, bind: params });
 *     }
 *     async query(sql, params = []) {
 *       const rows: any[] = [];
 *       this.db.exec({ sql, bind: params, rowMode: 'object',
 *                      callback: (row) => { rows.push(row); } });
 *       return rows;
 *     }
 *     async transaction(fn) {
 *       this.db.exec('BEGIN');
 *       try {
 *         const result = await fn(this);
 *         this.db.exec('COMMIT');
 *         return result;
 *       } catch (e) {
 *         this.db.exec('ROLLBACK');
 *         throw e;
 *       }
 *     }
 *     async close() { this.db.close(); }
 *   }
 *
 * apps/web imports the Storage interface from this package and provides
 * the wasm-specific implementation locally.
 */
export {};
