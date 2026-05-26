/**
 * Storage adapter for expo-sqlite (mobile). Implemented in apps/mobile,
 * not in this package — keeping core platform-free.
 *
 * Reference shape (do not import expo-sqlite here):
 *
 *   import * as SQLite from 'expo-sqlite';
 *
 *   export class SQLiteExpoAdapter implements Storage {
 *     private db: SQLite.SQLiteDatabase;
 *     constructor(dbName: string) {
 *       this.db = SQLite.openDatabaseSync(dbName);
 *       this.db.execSync('PRAGMA foreign_keys = ON');
 *     }
 *     async exec(sql, params = []) {
 *       await this.db.runAsync(sql, ...params);
 *     }
 *     async query(sql, params = []) {
 *       return this.db.getAllAsync(sql, ...params);
 *     }
 *     async transaction(fn) {
 *       return this.db.withTransactionAsync(() => fn(this));
 *     }
 *     async close() {
 *       await this.db.closeAsync();
 *     }
 *   }
 *
 * The implementation lives in apps/mobile so this package has no Expo
 * dependency. apps/mobile imports the Storage interface from here.
 */
export {};
