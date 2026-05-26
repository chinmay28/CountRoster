/**
 * Migration 001 — initial schema.
 *
 * SQL is embedded as a template literal (rather than a .sql file) so it is
 * portable across Node, Expo, and the browser without loader plumbing.
 *
 * If we ever want .sql files, the move is mechanical and the contract here
 * stays the same.
 */
export const M001_INITIAL = {
  version: 1,
  name: '001_initial',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trackers (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT,
      color             TEXT NOT NULL DEFAULT '#888888',
      icon              TEXT,
      kind              TEXT NOT NULL
                        CHECK (kind IN ('count','number','duration','boolean','choice')),
      unit              TEXT,
      target            REAL,
      reset_period      TEXT NOT NULL DEFAULT 'never'
                        CHECK (reset_period IN ('never','daily','weekly','monthly','yearly')),
      week_start        INTEGER NOT NULL DEFAULT 1 CHECK (week_start IN (0,1)),
      day_start_minute  INTEGER NOT NULL DEFAULT 0
                        CHECK (day_start_minute BETWEEN 0 AND 1439),
      default_value     REAL NOT NULL DEFAULT 1,
      archived_at       TEXT,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trackers_sort_idx
      ON trackers (sort_order, created_at);
    CREATE INDEX IF NOT EXISTS trackers_active_idx
      ON trackers (archived_at) WHERE archived_at IS NULL;

    CREATE TABLE IF NOT EXISTS tracker_options (
      id          TEXT PRIMARY KEY,
      tracker_id  TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      value       REAL NOT NULL,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tracker_options_tracker_idx
      ON tracker_options (tracker_id, sort_order);

    CREATE TABLE IF NOT EXISTS entries (
      id           TEXT PRIMARY KEY,
      tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      value        REAL NOT NULL,
      occurred_at  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_tracker_time_idx
      ON entries (tracker_id, occurred_at);
    CREATE INDEX IF NOT EXISTS entries_occurred_idx
      ON entries (occurred_at);

    CREATE TABLE IF NOT EXISTS notes (
      id           TEXT PRIMARY KEY,
      tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      entry_id     TEXT REFERENCES entries (id) ON DELETE SET NULL,
      body         TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_tracker_time_idx
      ON notes (tracker_id, occurred_at);

    CREATE TABLE IF NOT EXISTS note_edits (
      id         TEXT PRIMARY KEY,
      note_id    TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
      prev_body  TEXT NOT NULL,
      edited_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_edits_note_idx
      ON note_edits (note_id, edited_at);

    CREATE TABLE IF NOT EXISTS tracker_groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracker_group_memberships (
      tracker_id  TEXT NOT NULL REFERENCES trackers (id)       ON DELETE CASCADE,
      group_id    TEXT NOT NULL REFERENCES tracker_groups (id) ON DELETE CASCADE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tracker_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id           TEXT PRIMARY KEY,
      tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      time_minute  INTEGER NOT NULL CHECK (time_minute BETWEEN 0 AND 1439),
      days_mask    INTEGER NOT NULL DEFAULT 127,
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `,
} as const;
