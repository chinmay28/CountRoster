# CountRoster — Design & Architecture

CountRoster is a personal "anything tracker" — a small app that lets a user
define trackers (habits, medications, symptoms, spending, moods, etc.), tap to
log entries, attach journal notes, and visualize trends over time. The model is
inspired by [Tally](https://apps.apple.com/us/app/tally-the-anything-tracker/id1090990601)
but fixes three gaps users repeatedly call out in its App Store reviews:

1. **No structured data export.** Users can't get their data out except as opaque backup blobs.
2. **No proper visualization surface.** The phone is the only display; long-term analysis is cramped.
3. **No editing of journal notes.** Once written, a note is effectively frozen.

> **A note on history.** CountRoster began as a *local-first* app — per-device
> SQLite, native iOS/Android shells (Expo), and a web shell over sqlite-wasm/OPFS,
> with no server and data moving between devices only via backup files. It was
> deliberately pivoted to the **client-server** model described here so that every
> device reads and writes one shared dataset. This document describes the app **as
> built**; the data model, schema, service contracts, and backup format carry over
> essentially unchanged from the original design — only the *deployment topology*
> changed (one shared server instead of one DB per device).

## 1. Architecture at a glance

CountRoster is a **client-server** application: a thin browser client over a
shared backend, so every device — desktop or mobile — reads and writes the same
data.

```
browser PWA (apps/web)  ──HTTP/REST──>  Express API (apps/server)  ──>  @countroster/core  ──>  Storage adapter  ──>  node:sqlite file
```

- **One shared dataset.** `apps/server` (Express) owns a single SQLite file and
  is the source of truth. Every client reads and writes the same data through
  the REST API. `@countroster/core` (pure TypeScript, SQL-is-the-contract) runs
  **on the server**, over the file-backed `NodeSqliteAdapter`.
- **Thin PWA client.** `apps/web` is a mobile-friendly, installable PWA. Its API
  client (`src/api/client.ts`) exposes objects that mirror the core's service
  interfaces, so the React UI is unchanged whether it talks to a local core (in
  tests) or the HTTP API (in production).
- **No auth, by design.** The server runs on a *trusted network* (LAN /
  Tailscale / VPN). A shared server replaces backup-and-restore as the
  multi-device story.
- **No native shells.** The PWA covers both mobile and desktop — no App Store, no
  Play Store, no native build.

The three workspaces:

| Workspace | Package | Role |
|---|---|---|
| `packages/core` | `@countroster/core` | Platform-agnostic TS domain layer (schema, services, aggregations, backup). Runs **on the server**. |
| `apps/server`   | `@countroster/server` | Express REST API wiring the core over a `node:sqlite` file adapter. The single shared source of truth. |
| `apps/web`      | `@countroster/web` | Mobile-friendly, installable PWA (Vite + React) that talks to the server over HTTP. |

## 2. Goals and Non-goals

### Goals

- **One shared source of truth.** The server's SQLite database is authoritative;
  all clients read and write it through the REST API.
- **Portable data.** Backups use open formats (JSON, CSV, raw SQLite). A future
  maintainer — or another tool entirely — can read them with no proprietary knowledge.
- **Thin, swappable client.** The web client holds no business logic; its service
  objects mirror the core interfaces so the UI is identical against a real core
  (tests) or the HTTP client (production).
- **Small, well-tested core.** The domain layer is a pure TypeScript package with
  high test coverage, runnable in milliseconds with no native deps.
- **Editable history.** Journal notes are editable, with an append-only edit log
  so users can see and trust their own change history.
- **Rich visualization.** The web app is the analytical surface — charts,
  calendar heatmaps, trends, comparisons.

### Non-goals

- **No auth, no accounts, no cloud.** The server runs on a trusted network;
  anyone who can reach it can use it. There is no login, no per-user data.
- **No real-time multi-client conflict resolution.** Clients talk to one
  authoritative server over plain REST; there is no offline write queue or CRDT
  sync layer.
- **No native app shells.** iOS/Android coverage is via the installable PWA, not
  Expo or store-distributed binaries.
- **No HealthKit / Google Fit integration.** Out of scope.
- **No subscription, no payments, no analytics.** This is a personal-data tool.

## 3. Product Surface

### 3.1 Concepts

- **Tracker** — a named thing the user is tracking. Has a kind (count, number, duration, boolean, choice), a unit, a color, an optional target, and a reset period (never / daily / weekly / monthly / yearly).
- **Derived tracker** — a tracker whose value is *computed* from other trackers rather than logged directly (e.g. `Profit = Revenue − Expenses`). It looks and behaves like any other tracker — totals, charts, target progress, streaks — but its entries are virtual, synthesized from its sources. See §6.5.
- **Hidden tracker** — a tracker excluded from the roster unless the client opts into "hidden mode". Orthogonal to archiving. See §6.6.
- **Entry** — a single logged event for a tracker. Has a numeric value and a timestamp.
- **Note** — a free-text journal entry attached to a tracker, and optionally to a specific entry.
- **Group** — an optional collection of trackers for display organization.
- **Reminder** — a per-tracker schedule for notifications.

### 3.2 Core flows

| Flow | Description |
|---|---|
| **Tap to log** | One tap increments a count tracker by its `default_value` (usually 1). |
| **Custom log** | The detail screen lets the user enter a custom value and timestamp. |
| **Backdate** | Any entry can be edited, including its `occurred_at`. |
| **Add note** | Note can be standalone (tracker + timestamp) or attached to an existing entry. |
| **Edit note** | Editing rewrites the body; the previous body is appended to the audit log. |
| **View history** | Per-tracker timeline of entries and notes, with charts. |
| **Backup** | Download a `.countroster.zip` bundle or a raw SQLite snapshot from the API. |
| **Restore** | Upload a bundle; validate; replace the server DB contents. |

## 4. Architecture

### 4.1 Component boundaries

The system is split into layers with strict, one-way dependencies:

1. **Domain layer (`@countroster/core`)** — pure TypeScript, no React, no
   HTTP/Express, no network code. Knows about trackers, entries, notes; doesn't
   know about screens, routes, or sockets. Reaches outside SQL only through
   `crypto.subtle` (backup checksums), which exists in both Node and browsers.
2. **Storage adapter** — a ~4-method interface the domain layer uses to read and
   write. SQL *is* the contract: domain services write raw parameterized SQL and
   the adapter never parses or rewrites it. Implementations:
   - `NodeSqliteAdapter` (`apps/server/src/db/adapter.ts`) — `node:sqlite`, file-backed; the production engine.
   - `MemoryAdapter` (`packages/core/src/storage/memory.ts`) — `node:sqlite`, `:memory:`, used by tests.
3. **Server (`apps/server`)** — Express 5 REST API. Maps endpoints 1:1 onto core
   services and is the only thing that touches the SQLite file.
4. **Client (`apps/web`)** — a thin PWA. Its API client implements the same
   service interfaces the core exports, each method a `fetch`.

The client shares *no* business logic with the core beyond the interface shapes.
All domain logic lives in `@countroster/core` and runs server-side.

### 4.2 The composition root

`createApp(storage, { clock? })` (`src/createApp.ts`) wires every service over one
`Storage` and returns a `CountRosterCore` (`trackers`, `entries`, `notes`,
`groups`, `reminders`, `stats`, `backup`, `migrations`). It is called once at
startup **after opening the adapter**, then `app.migrations.run()` applies pending
migrations. The server's `boot()` (`apps/server/src/boot.ts`) does exactly this.

### 4.3 The client mirrors the core

`apps/web/src/api/client.ts` builds an `ApiCore` whose `trackers / entries / notes
/ groups / reminders / stats` objects implement the same interfaces the core
exports. `CoreContext` provides this HTTP client (production) or a real
`MemoryAdapter`-backed core (tests) — they're interchangeable because both satisfy
`ApiCore`. **The client's method signatures must stay in lockstep with the core
service interfaces**, or the swap breaks. Backup is not part of `ApiCore` (it
streams binary), so it's exposed via standalone helpers.

In production, `apps/server` serves the built `apps/web/dist` from the same origin
(SPA fallback), so it's one process and there is no CORS.

## 5. Technology Choices

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere | One language end-to-end; types are the contract layer. |
| Backend | Express 5 (ESM, `NodeNext`) | Small, well-understood REST surface over the core. |
| Database | `node:sqlite` (Node 22 built-in) | No native build step; same engine in tests (`:memory:`) and production (file). |
| Storage access | Hand-written parameterized SQL | Resist ORMs in the core. SQL is the contract between the domain and the engine. |
| Validation | Zod | Runtime validation that also yields compile-time types. |
| Client | Vite + React (PWA) | A pure SPA; vite-plugin-pwa supplies the manifest + service worker. |
| Charts | Observable Plot | Concise and analytical. |
| Testing | Vitest + in-memory adapter | Run the entire domain layer in milliseconds with no native deps. |

## 6. Data Model

The schema below is the canonical source of truth. All other representations
(JSON, CSV) derive from it.

### 6.1 Conventions

- **IDs** are UUIDv7 strings (`src/ids.ts`) — timestamp-sortable.
- **Timestamps** are ISO 8601 strings with a **local timezone offset**, e.g.
  `2026-05-25T14:32:00-07:00` (not UTC `Z`). The offset is needed for correct
  local-day bucketing. They are produced through the injected `Clock`
  (`src/time.ts`, `toLocalISO`), never `Date.now()`, so tests are deterministic.
- **Soft delete** is via `archived_at` for trackers; entries and notes are
  hard-deleted (the note edit log preserves history).
- **All tables include `created_at` / `updated_at`** where they make sense.

### 6.2 Base schema (migration 001)

```sql
-- Application metadata: schema version, settings flags
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

Migrations live in `src/schema/migrations/` as **numbered TypeScript objects**
with embedded SQL template literals (not `.sql` files — for cross-platform
portability). `index.ts` exports the ordered `MIGRATIONS` array and
`LATEST_VERSION`. The schema version lives in `app_meta` under key
`schema_version`. The runner (`src/migrations/runner.ts`):

1. Reads `schema_version`.
2. Applies any newer migrations in order, in a single transaction.
3. Updates `schema_version`.

It is **idempotent**. Migrations are **append-only**: never edit a shipped
migration — add a new one. When you change the schema, update three things in
lockstep: the migration SQL, the TS types in `src/schema/tables.ts`, and the Zod
validators in `src/schema/validators.ts`.

A backup with a *lower* schema version restores fine (rows are imported and the
running app is already migrated forward). A bundle from a *higher* schema version
than the running app is **rejected** with a clear error.

### 6.5 Derived trackers (migration 002)

A *derived* tracker computes its value from other trackers via a weighted linear
combination. It is an ordinary `trackers` row with `is_derived = 1`, plus one
`tracker_links` row per operand:

```sql
ALTER TABLE trackers ADD COLUMN is_derived INTEGER NOT NULL DEFAULT 0
  CHECK (is_derived IN (0, 1));

CREATE TABLE tracker_links (
  id           TEXT PRIMARY KEY,
  tracker_id   TEXT NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,  -- the derived tracker
  source_id    TEXT NOT NULL REFERENCES trackers (id) ON DELETE RESTRICT, -- a source tracker
  coefficient  REAL NOT NULL DEFAULT 1,                                   -- e.g. -1 to subtract
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (tracker_id, source_id)
);
```

**Semantics.** A derived tracker has no `entries` of its own. Its *effective*
entries are virtual: each source entry `(value v at time t)` contributes a row of
`coefficient × v` at `t`. Because the app's aggregations are sums, the weighted
combination falls out for free — `Profit = (+1 × ΣRevenue) + (−1 × ΣExpenses)`
over any range, bucket, or reset period. `EntryService.forTracker` and the
`StatsService` resolve a tracker's entry source through a single helper
(`domain/derived.ts → effectiveEntrySource`) so neither special-cases derivation
beyond that.

**Rules.** Direct logging on a derived tracker is rejected (`DerivedTrackerError →
HTTP 400`). A source must exist, be ordinary (no derived-of-derived nesting), and
not be the tracker itself; sources can't repeat. A source tracker **cannot be
archived or deleted while a derivation still references it** — both are blocked
with a `TrackerInUseError` (`HTTP 409`) that names the derived trackers in use, so
the user removes or unlinks them first (`source_id` is `ON DELETE RESTRICT` as a
DB-level backstop). Deleting a *derived* tracker is always fine: its own links
cascade away (`tracker_id` is `ON DELETE CASCADE`). Links are part of the backup
bundle, so derivations survive export/restore.

### 6.6 Hidden trackers (migration 003)

```sql
ALTER TABLE trackers ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0
  CHECK (is_hidden IN (0, 1));
```

A *hidden* tracker is excluded from `TrackerService.list()` unless the caller
explicitly opts in with `includeHidden` — clients only opt in while the user has
unlocked "hidden mode" in the UI. Hiding is **orthogonal to archiving**: an
archived tracker is off the roster but discoverable; a hidden one simply doesn't
exist as far as a non-opted-in caller can tell. Derivations may not mix hidden and
visible trackers; that invariant is enforced in the tracker service, not the
schema.

## 7. Core Domain: `@countroster/core`

### 7.1 Module layout

```
packages/core/
  src/
    schema/
      migrations/           # numbered TS migration objects (embedded SQL)
        001_initial.ts
        002_derived_trackers.ts
        003_hidden_trackers.ts
        index.ts            # ordered MIGRATIONS + LATEST_VERSION
      tables.ts             # TS types matching the schema
      validators.ts         # Zod schemas
    storage/
      adapter.ts            # Storage interface
      memory.ts             # in-memory (node:sqlite :memory:) — tests
    domain/
      trackers.ts
      entries.ts
      notes.ts
      groups.ts
      reminders.ts
      derived.ts            # effective-entry-source resolution for derived trackers
    aggregations/
      periods.ts            # date-range bucketing (day/week/month/year)
      stats.ts              # bucket / streak / targetProgress
    backup/
      bundle.ts             # .countroster.zip writer/reader
      manifest.ts           # bundle manifest Zod schema
      tables.ts             # the ordered set of backed-up tables + columns
      zip.ts                # minimal store-only zip reader/writer
      exporters/
        csv.ts
        json.ts
        sqlite.ts
    migrations/
      runner.ts
    createApp.ts            # composition root
    ids.ts                  # UUIDv7
    time.ts                 # Clock + local-ISO helpers
    index.ts                # curated public API
  test/
    ...                     # run against the in-memory adapter
```

> The `storage/sqlite-expo.ts` and `storage/sqlite-wasm.ts` files are stale
> relics of the local-first era and are not wired into the current app.

### 7.2 Storage adapter

The adapter is intentionally minimal. Domain code writes SQL directly; the adapter
exists only to abstract the engine. Both implementations load `node:sqlite` via
`process.getBuiltinModule('node:sqlite')` (not a static import) to dodge bundlers
that choke on `node:sqlite`.

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
// Single entry point — wire a storage adapter, get a fully constructed core.
export function createApp(storage: Storage, opts?: { clock?: Clock }): CountRosterCore;

export interface CountRosterCore {
  trackers:   TrackerService;
  entries:    EntryService;
  notes:      NoteService;
  groups:     GroupService;
  reminders:  ReminderService;
  stats:      StatsService;
  backup:     BackupService;
  migrations: MigrationRunner;
}
```

Each service is a small, focused object created by `createXService(storage,
clock)`. The pattern across all of them:

- **Validate inputs with Zod** (`src/schema/validators.ts`) at the top of write
  methods. Reads are trusted: rows come back typed via `query<T>` and cast.
- **Insert → re-`get()` → return** the persisted row, so callers always see
  DB-resolved defaults.

Representative interfaces:

```ts
export interface TrackerService {
  create(spec: TrackerInput): Promise<Tracker>;
  update(id: string, patch: TrackerPatch): Promise<Tracker>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  get(id: string): Promise<Tracker | null>;
  list(opts?: { includeArchived?: boolean; includeHidden?: boolean }): Promise<Tracker[]>;
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

export interface StatsService {
  bucket(trackerId: string, range: TimeRange, period: BucketPeriod): Promise<StatBucket[]>;
  streak(trackerId: string): Promise<{ current: number; longest: number }>;
  targetProgress(trackerId: string, at?: string): Promise<TargetProgress>;
}
```

The interfaces exported from `src/index.ts` are the spec. Anything the server or
client needs must be re-exported there.

### 7.4 Notes carry an append-only edit log

`notes.edit()` runs in a `storage.transaction`: it inserts the *previous* body
into `note_edits` before updating the row, and no-ops if the body is unchanged.
History is preserved only through `note_edits`.

### 7.5 Testing strategy

- Every service has a Vitest suite that runs against `MemoryAdapter`. Each test
  gets a fresh in-memory DB.
- `makeTestApp()` (`test/setup.ts`) opens a `MemoryAdapter`, builds the app with a
  **fixed clock**, runs migrations, and exposes `setTime(iso)` to advance time
  (default clock `2026-05-25T12:00:00.000-07:00`).
- Vitest globals are off; import `describe/it/expect` explicitly. Relative imports
  in `.ts` files carry the `.js` extension (ESM / `NodeNext` resolution).

Goal: **the entire domain layer is testable without booting a server or a browser**.

## 8. Backup & Restore

Backup is the egress point from the system. It must be reliable, restorable, and
human-inspectable. The `BackupService` runs in the core and is exposed by the
server over `/api/backup/*`; the web Data page calls those endpoints.

### 8.1 The bundle format (`.countroster.zip`)

Because the `Storage` contract is *SQL only* (no raw-file access), a bundle is a
**logical dump of the backed-up tables**, not a copy of the `.sqlite` file. The
zip is store-only (no compression):

```
countroster-2026-05-25.countroster.zip
├── manifest.json           # format/app/schema versions, row counts, checksum
├── all.json                # the full table dump (manifest + every table's rows)
└── exports/
    ├── trackers.csv
    ├── tracker_options.csv
    ├── entries.csv
    ├── notes.csv
    ├── note_edits.csv
    ├── tracker_groups.csv
    ├── tracker_group_memberships.csv
    ├── tracker_links.csv
    └── reminders.csv
```

The CSVs are for spreadsheet analysis; `all.json` is the restorable artifact. The
ordered set of tables and their columns lives in `src/backup/tables.ts`.

**`manifest.json` schema** (`src/backup/manifest.ts`):

```json
{
  "format_version": 1,
  "app_version": "0.1.0",
  "schema_version": 3,
  "exported_at": "2026-05-25T14:32:00-07:00",
  "row_counts": { "trackers": 12, "entries": 4831, "notes": 217 },
  "checksums": {
    "tables": "sha256:..."
  }
}
```

The `tables` checksum is the SHA-256 of a *canonical* serialization of the table
payload (tables emitted in `BACKUP_TABLES` order so the hash is stable). It
excludes the manifest itself to avoid a circular hash.

### 8.2 Restore flow

`importBundle(bytes, { confirmOverwrite })`:

1. Unzip and parse `all.json`; validate the embedded manifest with Zod.
2. Reject a bundle whose `format_version` doesn't match, or whose
   `schema_version` is **newer** than the running app (with a clear "upgrade the
   app" error).
3. Recompute the `tables` checksum and compare — reject on mismatch.
4. Unless `confirmOverwrite` is set, refuse if the DB already holds trackers.
5. In a single transaction: delete all backed-up tables (children before parents),
   then insert every row (parents before children).

**Forward-compatible inserts.** Only the columns a bundle actually carries are
bound. Older bundles predate later `ALTER TABLE`s (`is_derived`, `is_hidden`, …);
omitting those columns lets their SQL defaults apply rather than binding `NULL`
into a `NOT NULL` column. This is what lets an older backup restore onto a newer
app.

### 8.3 Raw SQLite snapshot

In addition to the logical bundle, the server can stream the raw database file
(`GET /api/backup/sqlite`) for a byte-for-byte snapshot. On a systemd install the
upgrade flow also snapshots the DB file (`+ WAL/SHM`) before each upgrade — see
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

## 9. Aggregations

`src/aggregations/periods.ts` (`bucketStart` / `bucketEnd` / `bucketLabel`) is
implemented and tested for day/week/month/year bucketing. `src/aggregations/stats.ts`
builds `bucket` / `streak` / `targetProgress` on top of it.

Weekly buckets respect `week_start`; monthly buckets are calendar months; yearly
buckets are calendar years. Bucketing currently uses host-local-time JS `Date`
math and does **not yet** honor per-tracker `day_start_minute` or custom
timezones — that work belongs in this module when added (see Appendix B).

## 10. What is *not* in `@countroster/core`

- React components, navigation, theming, styling → `apps/web`.
- HTTP / Express / routing → `apps/server`.
- Anything platform-specific (file system, notifications, sockets).

The core stays platform-agnostic so it can run identically in the server and in
the browser-based test harness. The boundary is a discipline, reinforced by the
curated `src/index.ts` public API.

## 11. Roadmap

### Done — domain core & client-server app

- `@countroster/core`: schema, migrations, services, aggregations, backup,
  in-memory adapter, with a Vitest suite.
- `apps/server`: Express REST API over the file-backed `node:sqlite` adapter.
- `apps/web`: installable PWA — home/roster, tracker create/edit, entry
  detail/edit/backdate, editable notes with history, charts, calendar heatmap,
  multi-tracker compare, groups, reminders, derived trackers, hidden mode, and a
  Data page over `BackupService`.

### Possible future work

- **Timezone-correct bucketing** that honors `day_start_minute` and a chosen
  timezone (Appendix B).
- **Reminder delivery** (the schema and CRUD exist; wiring actual notifications is
  a client/platform concern).
- **Optional access control** in front of the server for untrusted networks
  (today it relies on running on a trusted network).
- Public read-only sharing of selected trackers via signed exported HTML.

## 12. Out of Scope (Explicitly)

- User accounts, authentication, social features (the server assumes a trusted network).
- AI / LLM analysis of journal notes.
- Cloud storage of any kind owned by the project.
- Analytics, telemetry, crash reporting.
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
// → updates notes.body and notes.updated_at,
//   inserts the prior body into note_edits with edited_at = now
const history = await app.notes.history(noteId);
// → [{ prev_body: "Felt off today.", edited_at: "2026-05-25T..." }, ...]
```

### Take a backup

```ts
const bytes = await app.backup.exportBundle({ app_version: "0.1.0" });
// → Uint8Array of a .countroster.zip
//   The server streams it from GET /api/backup/bundle.
```

### Restore from a backup

```ts
const result = await app.backup.importBundle(bytes, { confirmOverwrite: true });
// → validates the manifest + checksum, then replaces table contents in one
//   transaction; returns { imported_rows, schema_version }.
```

## Appendix B — Period bucketing semantics (target)

For a tracker with `reset_period = 'daily'` and `day_start_minute = 240` (4:00 AM):

- "Today" begins at the most recent local-time 04:00 that has already passed.
- An entry logged at 03:30 AM falls into *yesterday's* bucket.
- This should be computed in the tracker's local timezone at `occurred_at`;
  backdated entries use their original local time.

This is the intended behavior; the current implementation uses host-local-time
`Date` math and does not yet honor `day_start_minute`. Property-testing the
boundary math (DST, week boundaries, custom `day_start_minute`) belongs with that
work.

## Appendix C — License

CountRoster is licensed under the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`); see [`LICENSE`](../LICENSE).

The AGPL was chosen deliberately over a permissive license. Because CountRoster is
a **network-served** application, the AGPL's §13 closes the "SaaS loophole":
anyone who runs a *modified* CountRoster server that others interact with over a
network must make the corresponding source of their modifications available under
the same license. A plain GPL would not impose this; a permissive license would
impose nothing.

Copyright is held by Chinmay Manjunath. Contributions are taken under a Contributor
License Agreement ([`CLA.md`](../CLA.md)) that grants the maintainer relicensing
rights — so the project can additionally be offered under separate commercial terms
(open-core / dual-license) without tracking down every contributor. The dependency
tree is kept entirely permissive (MIT/ISC/Apache-2.0/BSD) so nothing constrains
either the AGPL distribution or a future commercial edition. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
