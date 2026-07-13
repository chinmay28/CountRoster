/**
 * Migration 005 — imported credit-card transactions.
 *
 * `card_transactions` is a staging inbox: rows arrive from a CSV import as
 * `pending`, carry a suggested tracker, and on confirmation are filed into a
 * tracker as an Entry (plus a Note holding the transaction name) and flip to
 * `confirmed`. Dismissed rows become `ignored` rather than being deleted so
 * their `dedupe_key` keeps blocking re-import of the same CSV row.
 *
 * `category_rules` is the learned auto-categorization: a normalized merchant
 * key mapped to the tracker its transactions belong in, written every time a
 * transaction is confirmed.
 */
export const M005_CARD_TRANSACTIONS = {
  version: 5,
  name: '005_card_transactions',
  up: /* sql */ `
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
  `,
} as const;
