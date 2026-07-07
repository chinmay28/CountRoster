// Package migrate holds the append-only schema migrations and their runner.
//
// The SQL below is copied verbatim from the TypeScript core's
// schema/migrations — the two implementations must produce identical
// databases, and existing files carry data written by the old one. NEVER
// edit a shipped migration; add a new one.
package migrate

// Migration is one numbered, append-only schema step.
type Migration struct {
	Version int
	Name    string
	Up      string
}

// Migrations is the ordered list. Append-only.
var Migrations = []Migration{
	{Version: 1, Name: "001_initial", Up: m001Initial},
	{Version: 2, Name: "002_derived_trackers", Up: m002DerivedTrackers},
	{Version: 3, Name: "003_hidden_trackers", Up: m003HiddenTrackers},
	{Version: 4, Name: "004_snapshot_trackers", Up: m004SnapshotTrackers},
}

// LatestVersion is the highest schema version known to this build.
var LatestVersion = Migrations[len(Migrations)-1].Version

const m001Initial = `
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
  `

const m002DerivedTrackers = `
    ALTER TABLE trackers
      ADD COLUMN is_derived INTEGER NOT NULL DEFAULT 0
      CHECK (is_derived IN (0, 1));

    CREATE TABLE IF NOT EXISTS tracker_links (
      id           TEXT PRIMARY KEY,
      tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      source_id    TEXT NOT NULL REFERENCES trackers (id) ON DELETE RESTRICT,
      coefficient  REAL NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      UNIQUE (tracker_id, source_id)
    );
    CREATE INDEX IF NOT EXISTS tracker_links_tracker_idx
      ON tracker_links (tracker_id, sort_order);
    CREATE INDEX IF NOT EXISTS tracker_links_source_idx
      ON tracker_links (source_id);
  `

const m003HiddenTrackers = `
    ALTER TABLE trackers
      ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0
      CHECK (is_hidden IN (0, 1));
  `

const m004SnapshotTrackers = `
    ALTER TABLE trackers
      ADD COLUMN is_snapshot INTEGER NOT NULL DEFAULT 0
      CHECK (is_snapshot IN (0, 1));
  `
