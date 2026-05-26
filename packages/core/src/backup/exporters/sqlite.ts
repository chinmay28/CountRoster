/**
 * Return the raw SQLite file bytes for the current DB.
 *
 * Implementation strategy varies per adapter:
 *   - better-sqlite3: db.serialize() returns a Buffer.
 *   - expo-sqlite:    read the file from FileSystem.
 *   - sqlite-wasm:    sqlite3.capi.sqlite3_js_db_export(db).
 *
 * Implementation is delegated to the BackupService, which has access to the
 * underlying adapter; this file is a placeholder for any shared helpers.
 */
export {};
