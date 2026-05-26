# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CountRoster is a local-first "anything tracker" (habits, meds, symptoms, spending, moods). It will ship on iOS, Android, and web from a shared TypeScript core. **Only `@countroster/core` exists today** — the platform shells (`apps/mobile`, `apps/web`) are designed but not yet scaffolded. See `DESIGN.md` for the full architecture and roadmap, `DEPLOYMENT.md` for platform deployment notes.

## Commands

Run from the repo root (npm workspaces fan out to `packages/*`):

```bash
npm install          # requires Node >= 20.10; CI/dev uses Node 22
npm test             # vitest run across all packages
npm run build        # tsc — typechecks and emits dist/
npm run typecheck    # tsc --noEmit
```

Inside `packages/core` (or via `npm test --workspace @countroster/core`):

```bash
npm run test:watch                       # vitest watch mode
npx vitest run test/entries.test.ts      # a single test file
npx vitest run -t "logs an entry"        # a single test by name
```

There is no linter/formatter configured. TypeScript itself (strict mode) is the static-analysis gate.

## Architecture

Three layers with strict one-way dependencies. The shells will share **no** business logic — anything used by two shells lives in `@countroster/core`.

```
@countroster/core (pure TS)  →  Storage adapter (interface)  →  platform SQLite engine
```

### The Storage contract is SQL

`Storage` (`src/storage/adapter.ts`) is a ~4-method interface: `exec`, `query<T>`, `transaction`, `close`. **Domain services write raw parameterized SQL; the adapter never parses or rewrites it.** SQL *is* the contract between the domain and whatever engine a platform provides:

- `MemoryAdapter` (`src/storage/memory.ts`) — backed by Node 22's built-in `node:sqlite`, used by tests. Loaded via `process.getBuiltinModule('node:sqlite')` (not a static import) to dodge bundlers that choke on `node:sqlite`.
- `SQLiteExpoAdapter` / `SQLiteWasmAdapter` — mobile/web, not yet implemented.

Despite the filename "memory", the adapter is `node:sqlite`-based. The `testing.ts` and `sqlite.ts` source comments mention `better-sqlite3`; that's stale — the actual engine is `node:sqlite`.

### Composition root

`createApp(storage, { clock? })` in `src/createApp.ts` wires every service over one `Storage` and returns a `CountRosterCore` (`trackers`, `entries`, `notes`, `groups`, `reminders`, `stats`, `backup`, `migrations`). Call it once at startup **after opening the adapter**, then call `app.migrations.run()` to apply pending migrations. `src/index.ts` is the curated public API — anything platform shells need must be re-exported there.

### Service layer (`src/domain/`)

Each service is `createXService(storage, clock)` returning a small interface. Pattern across all of them:

- **Validate inputs with Zod** (`src/schema/validators.ts`) at the top of write methods, e.g. `entryLogInputSchema.parse(rawInput)`. Reads are trusted: rows come back typed via `query<Entry>` and cast, matching `src/schema/tables.ts`.
- **Insert → re-`get()` → return** the persisted row, so callers always see DB-resolved defaults.
- IDs come from `newId()` (`src/ids.ts`, UUIDv7 — timestamp-sortable).
- **Never call `Date.now()` / `new Date()` for persisted timestamps.** Go through the injected `Clock` (`src/time.ts`) so tests are deterministic. Timestamps are stored as **ISO 8601 with a local offset** (`toLocalISO`), not UTC `Z` — the offset is needed for correct local-day bucketing.

Fully implemented: `trackers`, `entries`, `notes`. **Stubbed (read-only or throwing TODOs):** `groups` and `reminders` only expose `list`/`forTracker`; `stats` (`src/aggregations/stats.ts`) and the entire `backup` layer (`src/backup/`) throw `"not yet implemented"`. The interfaces are the spec.

### Notes carry an append-only edit log

`notes.edit()` runs in a `storage.transaction`: it inserts the *previous* body into `note_edits` before updating the row, and no-ops if the body is unchanged. Entries and notes are hard-deleted; trackers soft-delete via `archived_at`. History is preserved only through `note_edits`.

### Migrations are append-only

`src/schema/migrations/` holds numbered migration objects (embedded SQL template literals, not `.sql` files, for cross-platform portability). `index.ts` exports the ordered `MIGRATIONS` array and `LATEST_VERSION`. The runner (`src/migrations/runner.ts`) reads `schema_version` from the `app_meta` table, applies pending migrations in one transaction, and is idempotent.

**Never edit a shipped migration — add a new one.** When you change the schema, update three things in lockstep: the migration SQL, the TS types in `src/schema/tables.ts`, and the Zod validators in `src/schema/validators.ts`.

### Aggregations

`src/aggregations/periods.ts` (`bucketStart`/`bucketEnd`/`bucketLabel`) is implemented and tested for day/week/month/year bucketing. It currently uses host-local-time JS `Date` math and does **not yet** honor per-tracker `day_start_minute` or custom timezones — that work belongs in this module when added (see DESIGN.md Appendix B).

## Testing conventions

- Tests live in `packages/core/test/` (excluded from the build). Each test gets a fresh in-memory DB.
- Use `makeTestApp()` from `test/setup.ts` — it opens a `MemoryAdapter`, builds the app with a **fixed clock**, runs migrations, and exposes `setTime(iso)` to advance time. Default clock is `2026-05-25T12:00:00.000-07:00`.
- Vitest globals are **off** (`vitest.config.ts`): import `describe/it/expect` explicitly.
- Note the `.js` extension on relative imports in `.ts` files (e.g. `from '../src/time.js'`) — required by the ESM/`NodeNext`-style module resolution; keep it consistent.

## Conventions to preserve

- ESM-only (`"type": "module"`). `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index access yields `T | undefined` (hence the `rows[0]!` / `?? null` patterns), and optional props can't be set to `undefined` explicitly.
- The core stays platform-agnostic: **no React, no `expo-*`, no `next/*`, no network code** in `packages/core`. Backups are the only data egress.
