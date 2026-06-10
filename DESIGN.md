# CountRoster — Design & Architecture

> ## 0. Architecture revision — client-server (current)
>
> **This is the authoritative description of the architecture as built.** The
> sections below (1–12) are the *original local-first design* and are retained
> for history/rationale; **where they conflict with this section, this section
> wins.** Passages that are superseded are flagged inline.
>
> CountRoster is now a **client-server** application, not local-first:
>
> ```
> browser PWA (apps/web)  ──HTTP/REST──>  Express API (apps/server)  ──>  @countroster/core  ──>  Storage adapter  ──>  node:sqlite file
> ```
>
> - **One shared dataset.** `apps/server` (Express) owns a single SQLite file and
>   is the source of truth. Every client — desktop or mobile — reads/writes the
>   same data through the REST API. `@countroster/core` is unchanged in spirit
>   (pure TS, SQL-is-the-contract) but runs **on the server**, over the
>   file-backed `NodeSqliteAdapter`.
> - **Thin PWA client.** `apps/web` is a mobile-friendly, installable PWA. Its API
>   client (`src/api/client.ts`) exposes objects that mirror the core's service
>   interfaces, so the React UI is unchanged by the move from a local core to HTTP.
> - **No auth, by design.** The server runs on a *trusted network* (LAN /
>   Tailscale / VPN). This is the "Option B"-adjacent decision: a shared server
>   replaces backup-and-restore as the multi-device story (cf. §10 Phase 4).
> - **No native shells.** The Expo (iOS/Android) and sqlite-wasm/OPFS web shells
>   from the original plan are dropped; the PWA covers mobile + desktop. The
>   `data model` (§6) and the `backup` format (§8) carry over, with backup now
>   served by the API rather than written to a device file.
>
> Everything below predates this pivot. Read it for the data model, schema,
> service contracts, and backup format — all still accurate — but treat the
> "local-first / no server / per-device DB" framing as historical.

## 1. Overview

We are building a personal "anything tracker" — a small app that lets a user define trackers (habits, medications, symptoms, spending, moods, etc.), tap to log entries, attach journal notes, and visualize trends over time. The model is inspired by [Tally](https://apps.apple.com/us/app/tally-the-anything-tracker/id1090990601) but fixes three gaps users repeatedly call out in its App Store reviews:

1. **No structured data export.** Users can't get their data out except as opaque backup blobs.
2. **No proper visualization surface.** The phone is the only display; long-term analysis is cramped.
3. **No editing of journal notes.** Once written, a note is effectively frozen.

The product ships on iOS, Android, and the desktop web. It is **local-first**: each device owns its data in a SQLite database. There is no server, no account, no subscription. Data leaves the device only as a backup file, written to a user-chosen location, in a fully documented, restorable format.

## 2. Goals and Non-goals

### Goals

- **Single source of truth per device.** The local SQLite database is authoritative. The app works fully offline, indefinitely.
- **Portable data.** Backup files use open formats (SQLite, JSON, CSV). A future maintainer — or another tool entirely — can read them with no proprietary knowledge.
- **Schema parity across platforms.** iOS, Android, and web run the same domain code and the same SQL schema. A backup taken on one device restores cleanly on another.
- **Small, well-tested components.** The domain layer is a pure TypeScript package with high test coverage. UI shells are thin.
- **Editable history.** Journal notes are editable, with an append-only edit log so users can see and trust their own change history.
- **Rich visualization on desktop.** The web app is the analytical surface — charts, calendar heatmaps, trends, comparisons.

### Non-goals (initial scope)

- **No server, no auth, no cloud account.** Multi-device sync via a server is explicitly out of scope.
- **No real-time multi-device sync.** Devices are independent; the user moves data between them via backup-and-restore. (A "shared cloud folder" sync mode is a clean v2 — see §10.)
- **No watch app, no widgets.** The user has indicated these are not desired; if added later, they require platform-native code.
- **No HealthKit / Google Fit integration.** Out of scope for v1.
- **No subscription, no payments, no analytics.** This is a personal-data tool.

## 3. Product Surface

### 3.1 Concepts

- **Tracker** — a named thing the user is tracking. Has a kind (count, number, duration, boolean, choice), a unit, a color, an optional target, and a reset period (never / daily / weekly / monthly / yearly).
- **Derived tracker** — a tracker whose value is *computed* from other trackers rather than logged directly (e.g. `Profit = Revenue − Expenses`). It looks and behaves like any other tracker — totals, charts, target progress, streaks — but its entries are virtual, synthesized from its sources. See §6.5.
- **Entry** — a single logged event for a tracker. Has a numeric value and a timestamp.
- **Note** — a free-text journal entry attached to a tracker, and optionally to a specific entry.
- **Group** — an optional collection of trackers for display organization.
- **Reminder** — a per-tracker schedule for notifications.

### 3.2 Core flows

| Flow | Description |
|---|---|
| **Tap to log** | One tap increments a count tracker by its `default_value` (usually 1). |
| **Custom log** | Long-press / detail screen lets the user enter a custom value and timestamp. |
| **Backdate** | Any entry can be edited, including its `occurred_at`. |
| **Add note** | Note can be standalone (tracker + timestamp) or attached to an existing entry. |
| **Edit note** | Editing rewrites the body; the previous body is appended to the audit log. |
| **View history** | Per-tracker timeline of entries and notes, with charts. |
| **Backup** | Manual or scheduled write of a backup file to a user-chosen location. |
| **Restore** | Pick a backup file; validate; replace local DB (with rollback safety). |
| **Export** | One-shot generation of structured files (CSV per table, JSON, full SQLite). |

## 4. Architecture

### 4.1 High level

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                    @countroster/core (TypeScript)                     │
│                                                                 │
│   ┌────────────┐  ┌─────────────┐  ┌────────────────────────┐   │
│   │  Domain    │  │ Aggregators │  │  Backup / Export /     │   │
│   │  Services  │  │   & Stats   │  │  Restore / Migrations  │   │
│   └─────┬──────┘  └─────┬───────┘  └──────────┬─────────────┘   │
│         │               │                     │                 │
│         └───────────────┴─────────────────────┘                 │
│                         │                                       │
│              ┌──────────▼──────────┐                            │
│              │   Storage adapter   │  (interface)               │
│              └──────────┬──────────┘                            │
└─────────────────────────┼───────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
┌──────▼──────┐   ┌───────▼──────┐   ┌───────▼────────┐
│  iOS app    │   │ Android app  │   │   Web app      │
│ (Expo +     │   │ (Expo +      │   │ (Next.js +     │
│  expo-      │   │  expo-       │   │  sqlite-wasm + │
│  sqlite)    │   │  sqlite)     │   │  OPFS)         │
└─────────────┘   └──────────────┘   └────────────────┘
```

### 4.2 The local-first principle

There is no remote source of truth. Every operation is a function of local state. Backups are *outputs* of the system, not inputs to a remote process. Restores are *inputs* that replace local state in a single transaction.

Consequences:

- No network code in the domain layer.
- No "loading" or "syncing" UI states tied to network. UI loading reflects local DB I/O only.
- All writes are durable before the UI confirms.
- The app must run forever without ever having been online.

### 4.3 Component boundaries

The system is split into three layers with strict, one-way dependencies:

1. **Domain layer (`@countroster/core`)** — pure TypeScript, no React, no platform APIs. Knows about trackers, entries, notes; doesn't know about screens or file pickers.
2. **Storage adapter** — a small interface (~6 methods) the domain layer uses to read and write. The package ships two implementations:
   - `SQLiteAdapter` for `expo-sqlite` (mobile)
   - `SQLiteAdapter` for `sqlite-wasm` (web)
   - `MemoryAdapter` for tests
3. **Platform shells** — Expo (iOS/Android) and Next.js (web). Each is a thin UI layer over `@countroster/core`, plus platform-specific code for file pickers, background tasks, and OS integration.

The shells share *no* business logic. If a feature is in two shells, it lives in `@countroster/core`.

## 5. Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere | One language end-to-end, type safety serves as the contract layer. |
| Mobile UI | Expo (React Native) | iOS + Android from one codebase; mature ecosystem. |
| Mobile DB | `expo-sqlite` | Native SQLite binding; matches the web engine. |
| Web framework | Next.js (App Router) or Vite + React Router | Choose Next.js if SEO / marketing pages matter; Vite for a pure SPA. Default: Next.js. |
| Web DB | `@sqlite.org/sqlite-wasm` with OPFS persistence | Same SQLite engine as mobile, schema parity, durable across reloads. |
| Validation | Zod | Runtime validation that also gives compile-time types. |
| Query builder | Hand-written SQL + a tiny helper | Resist ORMs in the core. SQL is the contract. |
| Testing | Vitest + an in-memory storage adapter | Run the entire domain layer in milliseconds with no native deps. |
| Charts (web) | Observable Plot (primary), Recharts (fallback) | Plot is concise and analytical; Recharts is more familiar React-shaped. |
| Charts (mobile) | Victory Native or react-native-svg + Plot pipeline | TBD; prototype both. |
| Packaging (mobile) | EAS Build | Standard Expo build pipeline. |

> Verify current major versions and any breaking changes for each library at the time of project kickoff; this space moves quickly.

## 6. Data Model

The schema below is the canonical source of truth. All other representations (JSON, CSV) derive from it.

### 6.1 Conventions

- **IDs** are UUIDv7 strings (sortable by creation time).
- **Timestamps** are ISO 8601 strings with timezone offsets, e.g. `2026-05-25T14:32:00-07:00`.
- **Soft delete** is via `archived_at` for trackers; entries and notes are hard-deleted (the note edit log preserves history).
- **All tables include `created_at` and `updated_at`** where they make sense.

### 6.2 Schema

```sql
-- Application metadata: schema version, install id, settings flags
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A tracker is the definition of a thing being tracked.
CREATE TABLE trackers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  color             TEXT NOT NULL DEFAULT '#888888',
  icon              TEXT,                                    -- icon name; nullable
  kind              TEXT NOT NULL
                    CHECK (kind IN ('count','number','duration','boolean','choice')),
  unit              TEXT,                                    -- e.g. "cups", "mg", null for count
  target            REAL,                                    -- goal value per reset period; nullable
  reset_period      TEXT NOT NULL DEFAULT 'never'
                    CHECK (reset_period IN ('never','daily','weekly','monthly','yearly')),
  week_start        INTEGER NOT NULL DEFAULT 1 CHECK (week_start IN (0,1)),  -- 0=Sun, 1=Mon
  day_start_minute  INTEGER NOT NULL DEFAULT 0 CHECK (day_start_minute BETWEEN 0 AND 1439),
  default_value     REAL NOT NULL DEFAULT 1,                 -- value used by quick-tap
  archived_at       TEXT,                                    -- ISO timestamp or null
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX trackers_sort_idx ON trackers (sort_order, created_at);
CREATE INDEX trackers_active_idx ON trackers (archived_at) WHERE archived_at IS NULL;

-- Predefined options for 'choice' kind trackers (e.g. mood: happy/sad/neutral)
CREATE TABLE tracker_options (
  id          TEXT PRIMARY KEY,
  tracker_id  TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  value       REAL NOT NULL,           -- numeric value stored in entries.value
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tracker_options_tracker_idx ON tracker_options (tracker_id, sort_order);

-- An entry is a single logged event.
CREATE TABLE entries (
  id           TEXT PRIMARY KEY,
  tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  value        REAL NOT NULL,
  occurred_at  TEXT NOT NULL,          -- when the thing happened (may be backdated)
  created_at   TEXT NOT NULL,          -- when the row was created
  updated_at   TEXT NOT NULL
);
CREATE INDEX entries_tracker_time_idx ON entries (tracker_id, occurred_at);
CREATE INDEX entries_occurred_idx     ON entries (occurred_at);

-- A note is a free-text journal entry. Optionally tied to a specific entry.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  entry_id     TEXT REFERENCES entries (id) ON DELETE SET NULL,
  body         TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX notes_tracker_time_idx ON notes (tracker_id, occurred_at);

-- Append-only audit log of note edits. Lets the user see prior versions.
CREATE TABLE note_edits (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  prev_body  TEXT NOT NULL,
  edited_at  TEXT NOT NULL
);
CREATE INDEX note_edits_note_idx ON note_edits (note_id, edited_at);

-- Optional groups for visual organization on the home screen.
CREATE TABLE tracker_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tracker_group_memberships (
  tracker_id  TEXT NOT NULL REFERENCES trackers (id)       ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES tracker_groups (id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tracker_id, group_id)
);

-- Per-tracker reminders (local notifications).
CREATE TABLE reminders (
  id           TEXT PRIMARY KEY,
  tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  time_minute  INTEGER NOT NULL CHECK (time_minute BETWEEN 0 AND 1439), -- minutes from local midnight
  days_mask    INTEGER NOT NULL DEFAULT 127,                              -- bit 0=Sun ... bit 6=Sat
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### 6.3 Value semantics by tracker kind

| `kind`     | `value` meaning                                    | Notes |
|------------|----------------------------------------------------|-------|
| `count`    | Increment amount (usually 1)                        | Sum entries to get the count for a period. |
| `number`   | The number recorded (e.g. weight, cups, dollars)   | Aggregations: sum, avg, min, max, last. |
| `duration` | Seconds                                            | Display as h/m/s. |
| `boolean`  | 0 or 1                                              | Typically one entry per day. |
| `choice`   | The selected option's `tracker_options.value`      | Stored numerically for charting. |

### 6.4 Migrations

The schema version lives in `app_meta` under key `schema_version`. Migrations are numbered SQL files (e.g. `001_initial.sql`, `002_add_groups.sql`) bundled into `@countroster/core`. On startup, the app:

1. Reads `schema_version`.
2. Applies any newer migrations in order, in a transaction.
3. Updates `schema_version`.

Restores from a backup with a *lower* schema version are migrated forward before being adopted. Restores from a *higher* version are rejected with a clear error.

### 6.5 Derived trackers (migration 002)

A *derived* tracker computes its value from other trackers via a weighted linear combination. It is an ordinary `trackers` row with `is_derived = 1`, plus one `tracker_links` row per operand:

```sql
ALTER TABLE trackers ADD COLUMN is_derived INTEGER NOT NULL DEFAULT 0
  CHECK (is_derived IN (0, 1));

CREATE TABLE tracker_links (
  id           TEXT PRIMARY KEY,
  tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,  -- the derived tracker
  source_id    TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,  -- a source tracker
  coefficient  REAL NOT NULL DEFAULT 1,                                   -- e.g. -1 to subtract
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (tracker_id, source_id)
);
```

**Semantics.** A derived tracker has no `entries` of its own. Its *effective* entries are virtual: each source entry `(value v at time t)` contributes a row of `coefficient × v` at `t`. Because the app's aggregations are sums, the weighted combination falls out for free — `Profit = (+1 × ΣRevenue) + (−1 × ΣExpenses)` over any range, bucket, or reset period. `EntryService.forTracker` and the `StatsService` resolve a tracker's entry source through a single helper (`domain/derived.ts → effectiveEntrySource`) so neither has to special-case derivation beyond that.

**Rules.** Direct logging on a derived tracker is rejected (`DerivedTrackerError → HTTP 400`). A source must exist, be ordinary (no derived-of-derived nesting), and not be the tracker itself; sources can't repeat. Deleting a source tracker cascades its links away (the derived tracker simply drops that operand). Links are part of the backup bundle, so derivations survive export/restore.

## 7. Core Domain: `@countroster/core`

### 7.1 Module layout

```
packages/core/
  src/
    schema/
      migrations/           # numbered SQL files
      tables.ts             # TS types matching the schema
      validators.ts         # Zod schemas
    storage/
      adapter.ts            # Storage interface
      sqlite-expo.ts        # expo-sqlite implementation
      sqlite-wasm.ts        # sqlite-wasm implementation
      memory.ts             # in-memory implementation for tests
    domain/
      trackers.ts
      entries.ts
      notes.ts
      groups.ts
      reminders.ts
    aggregations/
      periods.ts            # date-range bucketing (day/week/month/year)
      stats.ts              # sum, avg, streak, longest-gap, target-progress
    backup/
      bundle.ts             # .countroster.zip writer/reader
      exporters/
        csv.ts
        json.ts
        sqlite.ts
      manifest.ts           # bundle manifest schema
    migrations/
      runner.ts
    ids.ts                  # UUIDv7
    time.ts                 # tz-aware date helpers, period boundary math
    index.ts                # public API
  test/
    ...                     # mirrors src/, run against memory adapter
```

### 7.2 Storage adapter

The adapter is intentionally minimal. Domain code writes SQL directly; the adapter exists only to abstract the engine.

```ts
export interface Storage {
  exec(sql: string, params?: SqlParam[]): Promise<void>;
  query<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  transaction<T>(fn: (tx: Storage) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type SqlParam = string | number | null | Uint8Array;
```

### 7.3 Public API shape

```ts
// Single entry point — wire a storage adapter, get a fully constructed app.
export function createApp(storage: Storage): CountRosterCore;

export interface CountRosterCore {
  trackers: TrackerService;
  entries:  EntryService;
  notes:    NoteService;
  groups:   GroupService;
  reminders: ReminderService;
  agg:      AggregationService;
  backup:   BackupService;
  migrations: MigrationService;
}
```

Each service is a small, focused object. Example:

```ts
export interface TrackerService {
  create(spec: TrackerInput): Promise<Tracker>;
  update(id: string, patch: Partial<TrackerInput>): Promise<Tracker>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  get(id: string): Promise<Tracker | null>;
  list(opts?: { includeArchived?: boolean }): Promise<Tracker[]>;
}

export interface EntryService {
  log(trackerId: string, opts?: { value?: number; occurredAt?: string }): Promise<Entry>;
  update(id: string, patch: { value?: number; occurredAt?: string }): Promise<Entry>;
  delete(id: string): Promise<void>;
  forTracker(trackerId: string, range?: TimeRange): Promise<Entry[]>;
}

export interface NoteService {
  create(spec: NoteInput): Promise<Note>;
  edit(id: string, body: string): Promise<Note>;  // appends to note_edits
  delete(id: string): Promise<void>;
  history(noteId: string): Promise<NoteEdit[]>;
  forTracker(trackerId: string, range?: TimeRange): Promise<Note[]>;
}

export interface AggregationService {
  bucket(trackerId: string, range: TimeRange, period: BucketPeriod): Promise<Bucket[]>;
  streak(trackerId: string): Promise<{ current: number; longest: number }>;
  targetProgress(trackerId: string, at?: string): Promise<TargetProgress>;
}

export interface BackupService {
  exportBundle(): Promise<Uint8Array>;     // a .countroster.zip
  exportSQLite(): Promise<Uint8Array>;
  importBundle(bytes: Uint8Array, opts?: ImportOptions): Promise<ImportResult>;
}
```

### 7.4 Testing strategy

- Every service has a Vitest suite that runs against `MemoryAdapter`.
- The SQLite adapters are validated by a shared "contract test" — the same test suite runs against `MemoryAdapter`, `SQLiteExpoAdapter` (in a node-sqlite shim), and `SQLiteWasmAdapter` (in node).
- Property-based tests (fast-check) for time-bucketing edge cases (DST, week boundaries, custom `day_start_minute`).
- Snapshot tests for backup bundle shape.

Goal: **the entire domain layer is testable without booting Expo or a browser**.

## 8. Backup & Restore

Backup is the only egress point from the system. It must be reliable, restorable, and human-inspectable.

### 8.1 Outputs

| File                  | Purpose                                     | Restorable? |
|-----------------------|---------------------------------------------|-------------|
| `countroster-YYYYMMDD.sqlite` | Raw SQLite snapshot                       | ✅ primary path |
| `countroster-YYYYMMDD.countroster.zip` | Bundle: SQLite + JSON manifest + CSV/JSON dumps | ✅ primary path |
| `countroster-YYYYMMDD.json` | JSON-only export (lighter, human-readable) | ✅ secondary path |
| Individual CSVs       | One file per table for spreadsheet use      | ⚠️ partial — for analysis, not full restore |

### 8.2 Bundle format (`.countroster.zip`)

```
countroster-2026-05-25T14-32-00Z.countroster.zip
├── manifest.json
├── db.sqlite              # primary restorable artifact
└── exports/
    ├── trackers.csv
    ├── entries.csv
    ├── notes.csv
    ├── note_edits.csv
    ├── tracker_options.csv
    ├── tracker_groups.csv
    ├── tracker_group_memberships.csv
    ├── reminders.csv
    └── all.json           # full dump as a single JSON document
```

**`manifest.json` schema:**

```json
{
  "format_version": 1,
  "app_version": "0.1.0",
  "schema_version": 3,
  "exported_at": "2026-05-25T14:32:00-07:00",
  "device_id": "01HW...",
  "row_counts": {
    "trackers": 12,
    "entries": 4831,
    "notes": 217
  },
  "checksums": {
    "db.sqlite": "sha256:..."
  }
}
```

Restore validates `format_version`, checks `schema_version` against the current app, runs migrations if needed, verifies the SHA-256 of `db.sqlite`, then swaps it in.

### 8.3 Restore flow

1. User picks a file via the system file picker.
2. App reads manifest, validates format and checksum.
3. If `schema_version < current`, run migrations on a copy of the file.
4. If `schema_version > current`, refuse with a clear error ("upgrade the app to restore this backup").
5. Move the *current* local DB to a recovery slot (`countroster.local.prev.sqlite`).
6. Atomically swap in the restored DB.
7. If the next app launch fails to open the new DB, automatically restore the previous one and surface an error.

Keep the last 3 recovery slots. A bad restore is always undoable.

### 8.4 Where backups land

The user picks the destination per platform:

| Platform | Mechanism | Suggested defaults |
|---|---|---|
| iOS | `expo-document-picker`, `expo-file-system` | iCloud Drive folder, Files app, AirDrop |
| Android | Storage Access Framework via Expo | Google Drive, Dropbox, local Downloads |
| Web | File System Access API; falls back to download | User-chosen handle persisted in IndexedDB |

Scheduled backups:

- **Mobile:** `expo-background-fetch` — best-effort daily.
- **Web:** A foreground "back up now" button plus a "remind me weekly" prompt when the app is open. The File System Access API requires a user gesture; truly automatic web backups aren't possible without one.

Manual "back up now" is always available.

## 9. Platform Implementation Notes

### 9.1 Mobile (Expo)

- Single Expo project for iOS + Android.
- `expo-sqlite` for the database. The DB file lives in the app's documents directory.
- `expo-document-picker` + `expo-file-system` for backup destinations.
- `expo-notifications` for reminders.
- `expo-background-fetch` for scheduled backups.
- Build with EAS Build.
- iOS minimum: 16. Android minimum: 9 (API 28).

### 9.2 Web

- Next.js (App Router) or Vite + React Router — decide based on whether marketing pages are wanted.
- `@sqlite.org/sqlite-wasm` for the database, with **OPFS** for persistence.
- Loaded via dynamic `import()` so the WASM doesn't block first paint.
- File System Access API for backup destinations on Chromium browsers; download fallback elsewhere.
- The DB lives in OPFS at a known path. The "reset app" button is `OPFS.unlink`.

### 9.3 What is *not* in `@countroster/core`

- React components.
- Navigation.
- Theming / styling.
- File pickers.
- Notification scheduling.
- Anything `expo-*` or `next/*`.

The boundary is enforced by import lint rules.

## 10. Roadmap

### Phase 0 — Domain core (~1–2 weeks)

- `@countroster/core` package: schema, migrations, services, aggregations, backup, in-memory adapter.
- Vitest suite at >90% coverage.
- CLI binary (`countroster-cli`) that exercises the package end-to-end against an on-disk SQLite file. This is the "Log Depot core + CLI" pattern: prove the model is right before any UI exists.

### Phase 1 — Mobile (~2–4 weeks)

- Expo project with `expo-sqlite` adapter.
- Home screen (list of trackers, tap to log).
- Tracker create/edit.
- Entry detail / edit / delete / backdate.
- Notes with editable history view.
- Backup / restore UI.

### Phase 2 — Web (~2–3 weeks)

- Next.js project with `sqlite-wasm` + OPFS adapter.
- Mirrors mobile flows.
- Adds: rich charts (Plot), calendar heatmap, multi-tracker comparison, bulk edit.

### Phase 3 — Polish

- Reminders + notifications.
- Scheduled backups.
- Groups in the UI.
- Bulk export UI on top of `BackupService`.

### Phase 4 — Optional v2 features

- **Shared cloud folder sync** (the "Option B" from earlier discussion). Each device watches a chosen iCloud / Dropbox / Drive folder, writes its DB on change, reads on launch. Last-writer-wins. Implemented entirely on top of `BackupService`, no new core concepts.
- Widgets (iOS / Android — requires native code).
- Public read-only sharing of selected trackers via signed exported HTML.

## 11. Risks and Open Questions

| Risk / Question | Mitigation |
|---|---|
| `sqlite-wasm` + OPFS browser support | Verify on Safari and iOS Safari before committing. Have IndexedDB-via-Dexie ready as a fallback. Schema parity is the win — losing it is acceptable if web ergonomics suffer. |
| Background backup reliability on iOS | `expo-background-fetch` is best-effort. Communicate this honestly in the UI; provide foreground "back up now" prominently. |
| Backup file conflicts in shared-folder sync (Phase 4) | Last-writer-wins is good enough for personal use. Document the rule explicitly. |
| Timezone handling around `day_start_minute` and DST | Use a robust library (date-fns-tz or Temporal polyfill). Property-test the period boundary math heavily. |
| Web app written to OPFS is per-origin; clearing site data destroys it | Make the "your data lives here" reality explicit in onboarding. Encourage backup setup before the user logs much. |
| Project name | Working title only. Pick before any public publication. |

## 12. Out of Scope (Explicitly)

- Cross-device real-time sync via a server.
- User accounts, authentication, social features.
- AI / LLM analysis of journal notes.
- Cloud storage of any kind owned by the project.
- Analytics, telemetry, crash reporting beyond what Expo provides at build time.
- Monetization.

---

## Appendix A — Example operations end-to-end

### Tap to log a count tracker

```ts
const app = createApp(storage);
const entry = await app.entries.log(trackerId);
// → inserts a row in entries with value = tracker.default_value, occurred_at = now
```

### Edit a note (preserving history)

```ts
const updated = await app.notes.edit(noteId, "Felt better after a walk.");
// → updates notes.body, updates notes.updated_at,
//   inserts the prior body into note_edits with edited_at = now
const history = await app.notes.history(noteId);
// → [{ prev_body: "Felt off today.", edited_at: "2026-05-25T..." }, ...]
```

### Take a backup

```ts
const bytes = await app.backup.exportBundle();
// → Uint8Array of a .countroster.zip
//   The shell writes it to the user-picked location.
```

### Restore from a backup

```ts
const result = await app.backup.importBundle(bytes, { confirmOverwrite: true });
// → migrates the bundle's DB forward if needed,
//   atomically swaps it in,
//   returns { rowsImported, schemaVersion, previousSlot: "countroster.local.prev.sqlite" }
```

## Appendix B — Period bucketing semantics

For a tracker with `reset_period = 'daily'` and `day_start_minute = 240` (4:00 AM):

- "Today" begins at the most recent local-time 04:00 that has already passed.
- An entry logged at 03:30 AM falls into *yesterday's* bucket.
- This is computed in the tracker's local timezone at `occurred_at`; backdated entries use their original local time.

Weekly buckets respect `week_start`. Monthly buckets are calendar months. Yearly buckets are calendar years.
