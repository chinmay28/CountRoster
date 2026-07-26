/**
 * Migration 007 — per-entry custom fields.
 *
 * A tracker's primary `value` answers "how much"; a field answers everything
 * else about the same entry. A milk-feeding tracker counts millilitres and
 * carries a `choice` field ("bottle / formula / breast") and a `flag` field
 * ("wet diaper") alongside each feed, so the volume can be broken down by
 * either without splitting the tracker in two.
 *
 * `tracker_fields` declares what a tracker captures; `tracker_field_options`
 * holds the alternatives of a `choice` field; `entry_field_values` is the
 * per-entry answer — at most one row per (entry, field), which column it uses
 * follows the field's kind (choice → option_id, flag/number → number_value,
 * text → text_value).
 */
export const M007_TRACKER_FIELDS = {
  version: 7,
  name: '007_tracker_fields',
  up: /* sql */ `
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
  `,
} as const;
