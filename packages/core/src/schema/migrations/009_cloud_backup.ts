/**
 * Migration 009 — automatic cloud backup configuration.
 *
 * The server can export the backup bundle on a schedule and upload it to a
 * folder the user picked in their Dropbox or Google Drive. This table holds
 * everything that needs to survive a restart: which account is connected, the
 * OAuth tokens to reach it, the destination folder, the chosen frequency,
 * when the next run is due, and how the last one went.
 *
 * One row, `id = 'singleton'` — this is server-wide configuration, not a
 * per-user setting (there are no users). The migration seeds the row so every
 * read hits it and the domain only ever UPDATEs.
 *
 * The tokens live here rather than in a side file so a single SQLite path
 * stays the whole of the server's state. They are deliberately **not** part
 * of the backup bundle (see backup/tables.ts): an export is the documented
 * egress point and must not carry credentials, and restoring a bundle taken
 * on another machine must not repoint this server at that machine's cloud
 * account.
 */
export const M009_CLOUD_BACKUP = {
  version: 9,
  name: '009_cloud_backup',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS cloud_backup_settings (
      id                TEXT PRIMARY KEY CHECK (id = 'singleton'),
      provider          TEXT CHECK (provider IN ('dropbox','google_drive')),
      account_label     TEXT,
      access_token      TEXT,
      refresh_token     TEXT,
      token_expires_at  TEXT,
      folder_id         TEXT,
      folder_path       TEXT,
      frequency         TEXT NOT NULL DEFAULT 'off'
                        CHECK (frequency IN ('off','hourly','daily','weekly','monthly')),
      next_run_at       TEXT,
      last_run_at       TEXT,
      last_status       TEXT CHECK (last_status IN ('ok','error')),
      last_error        TEXT,
      last_file_name    TEXT,
      updated_at        TEXT
    );

    INSERT OR IGNORE INTO cloud_backup_settings (id, frequency)
      VALUES ('singleton', 'off');
  `,
} as const;
