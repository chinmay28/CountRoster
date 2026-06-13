# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CountRoster is an "anything tracker" (habits, meds, symptoms, spending, moods). It is a **client-server** application: a thin browser client over a shared backend, so every device — desktop or mobile — reads and writes the same data.

- `packages/core` (`@countroster/core`) — the platform-agnostic TypeScript domain layer (schema, services, aggregations, backup). Runs **on the server**.
- `apps/server` (`@countroster/server`) — an Express REST API that wires the core over a `node:sqlite` file adapter. This SQLite file is the single shared source of truth.
- `apps/web` (`@countroster/web`) — a mobile-friendly, installable **PWA** (Vite + React) that talks to the server over HTTP and behaves like an app.

> **History:** this project began *local-first* (per-device SQLite; web via sqlite-wasm/OPFS; Expo mobile shells). It was deliberately pivoted to client-server so all clients share one dataset. `docs/DESIGN.md`/`docs/DEPLOYMENT.md` describe the app *as built* (client-server) and keep only short historical notes about the old model. There is **no auth** by design: the server is meant to run on a trusted network (LAN/Tailscale/VPN).

See `docs/DESIGN.md` for architecture, `apps/server/README.md` and `apps/web/README.md` for shell specifics.

## Commands

Run from the repo root (npm workspaces fan out to `packages/*` and `apps/*`):

```bash
npm install          # requires Node >= 20.10; CI/dev uses Node 22
npm test             # vitest run across all packages
npm run build        # build every workspace (core: tsc; server: tsc; web: vite)
npm run typecheck    # tsc --noEmit across workspaces
```

Run the app in development (two processes; **build core first** so its `dist/` exists):

```bash
npm run build --workspace @countroster/core         # the server & web import the compiled core
npm run dev   --workspace @countroster/server        # API on http://localhost:8787 (COUNTROSTER_DB, PORT, HOST envs)
npm run dev   --workspace @countroster/web           # PWA on http://localhost:5173, proxies /api → server
```

In production, `apps/server` serves the built `apps/web/dist` from the same origin (SPA fallback), so it's one process and no CORS.

Single core test: `npx vitest run test/entries.test.ts` (or `-t "name"`) inside `packages/core`.

There is no linter/formatter configured. TypeScript itself (strict mode) is the static-analysis gate.

## Architecture

```
browser PWA (apps/web)  ──HTTP/REST──>  Express API (apps/server)  ──>  @countroster/core  ──>  Storage adapter  ──>  node:sqlite file
```

The client holds **no business logic** — it's a typed HTTP client whose service objects (`apps/web/src/api/client.ts`) mirror the core's service interfaces, so React pages call `core.trackers.list()` etc. regardless of whether that's a local core (tests) or the API client (production). All domain logic lives in `@countroster/core` and runs server-side.

### The Storage contract is SQL

`Storage` (`src/storage/adapter.ts`) is a ~4-method interface: `exec`, `query<T>`, `transaction`, `close`. **Domain services write raw parameterized SQL; the adapter never parses or rewrites it.** SQL *is* the contract between the domain and whatever engine provides it:

- `MemoryAdapter` (`packages/core/src/storage/memory.ts`) — `node:sqlite`, `:memory:`, used by tests.
- `NodeSqliteAdapter` (`apps/server/src/db/adapter.ts`) — `node:sqlite`, file-backed; the production engine. Same engine as the test adapter, just on disk.
- Both load `node:sqlite` via `process.getBuiltinModule('node:sqlite')` (not a static import) to dodge bundlers that choke on `node:sqlite`. The `sqlite-expo.ts`/`sqlite-wasm.ts` sketches and the `testing.ts`/`sqlite.ts` `better-sqlite3` comments are stale relics of the local-first era.

### Composition root

`createApp(storage, { clock? })` in `src/createApp.ts` wires every service over one `Storage` and returns a `CountRosterCore` (`trackers`, `entries`, `notes`, `groups`, `reminders`, `stats`, `backup`, `migrations`). Call it once at startup **after opening the adapter**, then call `app.migrations.run()` to apply pending migrations. The server's `boot()` (`apps/server/src/boot.ts`) does exactly this. `src/index.ts` is the curated public API — anything the server/client need must be re-exported there.

### Server (`apps/server`)

Express 5, ESM, `NodeNext` module resolution (so the compiled `dist/` runs under Node ESM). `buildApp(core, opts)` (`src/app.ts`) registers the REST routes and a single error middleware that maps `ZodError → 400` and any `*NotFoundError → 404`; everything else is 500. `boot()` opens the file adapter, builds the core, runs migrations. `server.ts` listens and, when `apps/web/dist` exists, serves it from the same origin with an SPA fallback. Endpoints map 1:1 to core services (e.g. `POST /api/trackers`, `GET /api/trackers/:id/stats/streak`, `GET /api/backup/bundle`). `COUNTROSTER_DB=:memory:` is honored as a SQLite sentinel; tests boot against it.

### Client (`apps/web`)

A thin PWA. `src/api/client.ts` builds an `ApiCore` whose `trackers/entries/notes/groups/reminders/stats` objects implement the same interfaces the core exports, each method a `fetch`. `.get(id)` lookups return `null` on 404. `CoreContext` provides this client (production) or a real `MemoryAdapter`-backed core (tests) — they're interchangeable because both satisfy `ApiCore`. **Keep the client's method signatures in lockstep with the core service interfaces**, or the swap breaks. Backup is not part of `ApiCore` (binary streams); it's exposed via standalone helpers (`backupBundleUrl`, `importBackup`). vite-plugin-pwa supplies the manifest/service worker; the SW must **not** cache `/api`.

### Service layer (`src/domain/`)

Each service is `createXService(storage, clock)` returning a small interface. Pattern across all of them:

- **Validate inputs with Zod** (`src/schema/validators.ts`) at the top of write methods, e.g. `entryLogInputSchema.parse(rawInput)`. Reads are trusted: rows come back typed via `query<Entry>` and cast, matching `src/schema/tables.ts`.
- **Insert → re-`get()` → return** the persisted row, so callers always see DB-resolved defaults.
- IDs come from `newId()` (`src/ids.ts`, UUIDv7 — timestamp-sortable).
- **Never call `Date.now()` / `new Date()` for persisted timestamps.** Go through the injected `Clock` (`src/time.ts`) so tests are deterministic. Timestamps are stored as **ISO 8601 with a local offset** (`toLocalISO`), not UTC `Z` — the offset is needed for correct local-day bucketing.

All services are now fully implemented: `trackers`, `entries`, `notes`, `groups` (CRUD + membership), `reminders` (CRUD + toggle), `stats` (`src/aggregations/stats.ts`: `bucket`/`streak`/`targetProgress`), and `backup` (`src/backup/`). The interfaces in each module are the spec.

### Notes carry an append-only edit log

`notes.edit()` runs in a `storage.transaction`: it inserts the *previous* body into `note_edits` before updating the row, and no-ops if the body is unchanged. Entries and notes are hard-deleted; trackers soft-delete via `archived_at`. History is preserved only through `note_edits`.

### Migrations are append-only

`src/schema/migrations/` holds numbered migration objects (embedded SQL template literals, not `.sql` files, for cross-platform portability). `index.ts` exports the ordered `MIGRATIONS` array and `LATEST_VERSION`. The runner (`src/migrations/runner.ts`) reads `schema_version` from the `app_meta` table, applies pending migrations in one transaction, and is idempotent.

**Never edit a shipped migration — add a new one.** When you change the schema, update three things in lockstep: the migration SQL, the TS types in `src/schema/tables.ts`, and the Zod validators in `src/schema/validators.ts`.

### Aggregations

`src/aggregations/periods.ts` (`bucketStart`/`bucketEnd`/`bucketLabel`) is implemented and tested for day/week/month/year bucketing. It currently uses host-local-time JS `Date` math and does **not yet** honor per-tracker `day_start_minute` or custom timezones — that work belongs in this module when added (see docs/DESIGN.md Appendix B).

## Testing conventions

- Tests live in `packages/core/test/` (excluded from the build). Each test gets a fresh in-memory DB.
- Use `makeTestApp()` from `test/setup.ts` — it opens a `MemoryAdapter`, builds the app with a **fixed clock**, runs migrations, and exposes `setTime(iso)` to advance time. Default clock is `2026-05-25T12:00:00.000-07:00`.
- Vitest globals are **off** (`vitest.config.ts`): import `describe/it/expect` explicitly.
- Note the `.js` extension on relative imports in `.ts` files (e.g. `from '../src/time.js'`) — required by the ESM/`NodeNext`-style module resolution; keep it consistent.

## Conventions to preserve

- ESM-only (`"type": "module"`). `tsconfig.base.json` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — index access yields `T | undefined` (hence the `rows[0]!` / `?? null` patterns), and optional props can't be set to `undefined` explicitly.
- The core stays platform-agnostic: **no React, no HTTP/Express, no network code** in `packages/core`. HTTP belongs to `apps/server`; React/PWA belongs to `apps/web`. The core reaches outside SQL only through `crypto.subtle` (backup checksums), which exists in both Node and browsers.
- The server is `NodeNext` (real Node ESM, `.js` import extensions in compiled output); the core and web use `bundler` resolution. Keep imports consistent within each package.

## Licensing & contributions

- CountRoster is licensed **`AGPL-3.0-only`** (`LICENSE` is the canonical GNU AGPL-3.0 text). Every workspace `package.json` carries `"license": "AGPL-3.0-only"`; keep that field on any new package you add.
- **Dependencies must be AGPL-compatible.** The current tree is entirely permissive (MIT/ISC/Apache-2.0/BSD/BlueOak). Do **not** add a dependency under a GPL-incompatible or proprietary license without flagging it — it can taint the whole project. Permissive licenses (MIT/Apache-2.0/BSD/ISC) are fine; another copyleft license needs review.
- **Contributions run through the CLA** (`CLA.md`), accepted via a DCO `Signed-off-by` line — commit with `git commit -s`. The CLA grants the maintainer relicensing rights so the project can be dual-licensed commercially later; preserve that intent in any contribution tooling.
- It's a network app, so **AGPL §13 applies to operators**: a modified server offered over a network must make its source available. Keep that note in the user-facing docs (`README.md`, `docs/DEPLOYMENT.md`).
- See `CONTRIBUTING.md` for the contributor workflow.
