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
	{Version: 5, Name: "005_card_transactions", Up: m005CardTransactions},
	{Version: 6, Name: "006_period_windows", Up: m006PeriodWindows},
	{Version: 7, Name: "007_tracker_fields", Up: m007TrackerFields},
	{Version: 8, Name: "008_section_order", Up: m008SectionOrder},
	{Version: 9, Name: "009_cloud_backup", Up: m009CloudBackup},
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

const m005CardTransactions = `
    CREATE TABLE IF NOT EXISTS card_transactions (
      id               TEXT PRIMARY KEY,
      posted_at        TEXT NOT NULL,
      amount           REAL NOT NULL,
      name             TEXT NOT NULL,
      raw_description  TEXT NOT NULL,
      account          TEXT,
      category         TEXT,
      dedupe_key       TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','confirmed','ignored')),
      tracker_id       TEXT REFERENCES trackers (id) ON DELETE SET NULL,
      entry_id         TEXT REFERENCES entries (id) ON DELETE SET NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_transactions_status_idx
      ON card_transactions (status, posted_at, id);

    CREATE TABLE IF NOT EXISTS category_rules (
      id          TEXT PRIMARY KEY,
      merchant    TEXT NOT NULL UNIQUE,
      tracker_id  TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS category_rules_tracker_idx
      ON category_rules (tracker_id);
  `

const m006PeriodWindows = `
    ALTER TABLE trackers
      ADD COLUMN month_start_day INTEGER NOT NULL DEFAULT 1
      CHECK (month_start_day BETWEEN 1 AND 28);

    ALTER TABLE trackers
      ADD COLUMN year_start_month INTEGER NOT NULL DEFAULT 1
      CHECK (year_start_month BETWEEN 1 AND 12);
  `

const m007TrackerFields = `
    CREATE TABLE IF NOT EXISTS tracker_fields (
      id          TEXT PRIMARY KEY,
      tracker_id  TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL
                  CHECK (kind IN ('choice','flag','number','text')),
      unit        TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tracker_fields_tracker_idx
      ON tracker_fields (tracker_id, sort_order);

    CREATE TABLE IF NOT EXISTS tracker_field_options (
      id          TEXT PRIMARY KEY,
      field_id    TEXT NOT NULL REFERENCES tracker_fields (id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      color       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tracker_field_options_field_idx
      ON tracker_field_options (field_id, sort_order);

    CREATE TABLE IF NOT EXISTS entry_field_values (
      id            TEXT PRIMARY KEY,
      entry_id      TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
      field_id      TEXT NOT NULL REFERENCES tracker_fields (id) ON DELETE CASCADE,
      option_id     TEXT REFERENCES tracker_field_options (id) ON DELETE CASCADE,
      number_value  REAL,
      text_value    TEXT,
      UNIQUE (entry_id, field_id)
    );
    CREATE INDEX IF NOT EXISTS entry_field_values_entry_idx
      ON entry_field_values (entry_id);
    CREATE INDEX IF NOT EXISTS entry_field_values_field_idx
      ON entry_field_values (field_id, option_id);
  `

// m008SectionOrder stores the user's preferred order for the sections of a
// tracker's detail page as a comma-separated list of section keys
// ("summary,trends,log,entries,notes"). NULL means "the default order".
// The domain treats the keys as opaque slugs — which sections exist is the
// client's business, and an order naming keys the client doesn't know is
// ignored rather than rejected, so an older client stays usable.
const m008SectionOrder = `
    ALTER TABLE trackers ADD COLUMN section_order TEXT;
  `

// m009CloudBackup stores the automatic cloud backup configuration: which
// cloud account the server may write to, the folder chosen inside it, how
// often to export, and the outcome of the last run.
//
// One row, `id = 'singleton'` — this is server-wide configuration, not a
// per-user setting (there are no users). The migration seeds the row so
// every read hits it and the domain only ever UPDATEs.
//
// The OAuth tokens live here rather than in a side file so a single SQLite
// path stays the whole of the server's state. They are deliberately **not**
// in the backup bundle (see internal/backup/tables.go): an export is the
// documented egress point and must not carry credentials, and restoring a
// bundle taken on another machine must not repoint this server at that
// machine's cloud account.
const m009CloudBackup = `
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
  `
