# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CountRoster is an "anything tracker" (habits, meds, symptoms, spending, moods). It is a **client-server** application: a thin browser client over a shared backend, so every device — desktop or mobile — reads and writes the same data.

- `server/` — the **Go** backend: domain layer (schema, services, aggregations, backup) + REST API over a `modernc.org/sqlite` file. Compiles to **one static binary** that also serves the PWA. This SQLite file is the single shared source of truth.
- `apps/web` (`@countroster/web`) — a mobile-friendly, installable **PWA** (Vite + React) that talks to the server over HTTP and behaves like an app.
- `packages/core` (`@countroster/core`) — the *original* TypeScript domain layer, now retained **only** as the web client's type source and in-memory test double. It is not the production path.

> **History:** this project began *local-first* (per-device SQLite; Expo shells), pivoted to client-server on Node/Express/TypeScript, and was then **rewritten in Go** with zero contract changes — the REST API, SQL schema, on-disk SQLite file, and backup format are bit-compatible with the TS implementation, and the UI didn't change at all. Parts of `DESIGN.md`/`DEPLOYMENT.md` describe the older eras — they're marked where superseded. There is **no auth** by design: the server runs on a trusted network (LAN/Tailscale/VPN).

See `DESIGN.md` for architecture, `server/README.md` and `apps/web/README.md` for specifics.

## Commands

Run from the repo root:

```bash
npm install          # Node >= 20.10 (build/dev tooling for the TS workspaces)
npm test             # vitest (core + web) AND `go test ./...` (server)
npm run build        # TS workspaces + `go build` → server/bin/countroster
npm run typecheck    # tsc --noEmit + `go vet`
```

Go-only iteration (fast):

```bash
cd server
go test ./...        # the authoritative domain + API suites
go build ./...       # compile check
```

Run the app in development (two processes; **build core first** so the web client's imported types exist):

```bash
npm run build --workspace @countroster/core          # web imports the compiled core's types
(cd server && go run ./cmd/countroster serve)         # API on http://localhost:8787 (config via serve flags: --db/--port/--host)
npm run dev   --workspace @countroster/web            # PWA on http://localhost:5173, proxies /api → server
```

The `serve` subcommand (also the default with no args) takes `--host`, `--port`, `--db`, and `--web-dist` flags; each **overrides** its env-var fallback (`HOST`, `PORT`, `COUNTROSTER_DB`, `WEB_DIST`), which overrides the built-in default. Prefer the flags — the env vars remain only as fallbacks (and for the Node-era quickstart path). `countroster version`/`--version` prints the version.

In production the Go binary serves the built `apps/web/dist` (embedded at build time or via `--web-dist`) from the same origin with an SPA fallback — one process, no CORS.

Single Go package test: `go test ./internal/core -run TestStreak` inside `server/`. Single web test: `npx vitest run src/app/app.test.tsx` inside `apps/web`.

There is no linter/formatter beyond `gofmt`/`go vet` (server) and TypeScript strict mode (web).

## Architecture

```
browser PWA (apps/web)  ──HTTP/REST──>  Go server (server/)  ──>  SQLite file
```

The client holds **no business logic** — it's a typed HTTP client whose service objects (`apps/web/src/api/client.ts`) mirror the domain service interfaces, so React pages call `core.trackers.list()` etc. regardless of whether that's a local TS core (component tests) or the API client (production). All domain logic lives in `server/internal/core` and runs server-side.

### The wire contract is frozen

The PWA is compiled against the REST API's exact shapes: snake_case JSON field names, `0 | 1` integer flags (`is_derived`, `is_hidden`, `is_snapshot`, `week_start`), explicit `null`s, `{"error": …}` error bodies, statuses 201/204/400/404/409. `server/internal/api/api_test.go` pins the contract; change it only together with `apps/web/src/api/client.ts` and the TS types in `packages/core`.

### The Storage contract is SQL

`storage.Storage` (`server/internal/storage`) is a 4-method interface: `Exec`, `Query`, `Transaction`, `Close`. **Domain services write raw parameterized SQL; the adapter never parses or rewrites it.** SQL *is* the contract. The engine is `modernc.org/sqlite` (pure Go — this is what keeps the binary CGO-free/static), file-backed in production, `:memory:` in tests. WAL mode, foreign keys ON, single pooled connection.

### Composition root

`cmd/countroster/main.go` does: open storage → `migrate.Run` → `core.New(storage, clock)` → `api.New(...)` → serve. `core.App` bundles the services (`Trackers`, `Entries`, `Notes`, `Groups`, `Stats`, `Transactions`); backup is `backup.Service`.

### Service layer (`server/internal/core`)

Pattern across all services (ported from the TS core):

- **Validate inputs** at the top of write methods via the parsers in `validate.go` (a port of the Zod schemas — same defaults, same limits, presence-aware so PATCH distinguishes absent / null / value).
- **Insert → re-`Get()` → return** the persisted row, so callers always see DB-resolved defaults.
- IDs come from `ids.New()` (UUIDv7 — timestamp-sortable, monotonic within a millisecond; SQL tie-breaks on `id` rely on this).
- **Never call `time.Now()` for persisted timestamps.** Go through the injected `Clock` (`internal/timeutil`) so tests are deterministic. Timestamps are stored as **ISO 8601 with a local offset** (`ToLocalISO`), not UTC `Z` — the offset is needed for correct local-day bucketing. SQL range comparisons use `julianday()` so mixed offsets compare as instants.

Errors map to HTTP in `api.handleErr`: `ValidationError`→400, `NotFoundError`→404, `DerivedTrackerError`→400, `TrackerInUseError`→409, anything else→500.

### Notes carry an append-only edit log

`Notes.Update` runs in a transaction: it inserts the *previous* body into `note_edits` before updating the row, and no-ops if nothing changed. Entries and notes are hard-deleted; trackers soft-delete via `archived_at`.

### Migrations are append-only

`server/internal/migrate` holds the numbered migrations (SQL copied **verbatim** from the TS core — both implementations must produce identical databases) and the runner (reads `schema_version` from `app_meta`, applies pending migrations in one transaction, idempotent).

**Never edit a shipped migration — add a new one.** When you change the schema, update in lockstep: the migration SQL, the row structs in `internal/core/types.go`, the validators in `internal/core/validate.go`, the backup table list in `internal/backup/tables.go`, **and** the TS mirrors (`packages/core/src/schema/{tables,validators}.ts` + a matching TS migration) so the web test double stays faithful.

### Backup format is cross-implementation

`internal/backup` produces/consumes the `.countroster.zip` bundle (manifest + `all.json` + CSVs, stored uncompressed). The manifest checksum is SHA-256 over the **JavaScript-canonical** JSON serialization of the tables — `internal/jsjson` reproduces `JSON.stringify` byte-for-byte (ECMA number formatting, minimal escaping, insertion-ordered keys). Golden fixtures in `internal/backup/testdata/` (a bundle exported by the TS implementation) prove bundles round-trip across implementations; don't regenerate them casually. (Reminders were removed as a feature; the `reminders` table remains in the schema because migrations are append-only and old backups must round-trip.)

### Aggregations

`internal/core/periods.go` (`bucketStart`/`bucketEnd`/`bucketLabel`) implements day/week/month/year bucketing in host-local time, mirroring the JS `Date` math of the original. It does **not yet** honor per-tracker `day_start_minute` or custom timezones — that work belongs in this file when added (see DESIGN.md Appendix B).

## Testing conventions

- Go tests live next to the code (`server/internal/**/*_test.go`), one suite per original vitest file. Each test opens a fresh `:memory:` DB via `newTestApp` (fixed clock `2026-05-25T12:00:00.000-07:00`, advanced with `setTime`).
- Cross-implementation guarantees are golden-fixture tests: `internal/jsjson` (number/string formatting vs `JSON.stringify`) and `internal/backup` (a Node-exported bundle must import with checksums verifying).
- Web component tests (`apps/web`) still run against the TS core over a `MemoryAdapter` (`makeTestCore`) — that's why `packages/core` remains. Keep its validators/types in lockstep with the Go ones.
- TS tests use vitest with globals **off**: import `describe/it/expect` explicitly; note the `.js` extension on relative imports in `.ts` files.

## Conventions to preserve

- The Go server owns all HTTP; **no React or network code in `packages/core`**, no business logic in `apps/web`.
- `CGO_ENABLED=0` must keep working — don't introduce cgo dependencies; the single-static-binary deploy depends on it.
- TS workspaces stay ESM-only (`"type": "module"`), strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- The PWA service worker must **not** cache `/api` (see `apps/web/vite.config.ts`).

## Licensing & contributions

- CountRoster is licensed **`AGPL-3.0-only`** (`LICENSE` is the canonical GNU AGPL-3.0 text). Every workspace `package.json` carries `"license": "AGPL-3.0-only"`; keep that field on any new package you add.
- **Dependencies must be AGPL-compatible.** The current tree is entirely permissive (MIT/ISC/Apache-2.0/BSD/BlueOak; the Go module tree is BSD-3-Clause). Do **not** add a dependency under a GPL-incompatible or proprietary license without flagging it — it can taint the whole project. Permissive licenses (MIT/Apache-2.0/BSD/ISC) are fine; another copyleft license needs review.
- **Contributions run through the CLA** (`CLA.md`), accepted via a DCO `Signed-off-by` line — commit with `git commit -s`. The CLA grants the maintainer relicensing rights so the project can be dual-licensed commercially later; preserve that intent in any contribution tooling.
- It's a network app, so **AGPL §13 applies to operators**: a modified server offered over a network must make its source available. Keep that note in the user-facing docs (`README.md`, `DEPLOYMENT.md`).
- See `CONTRIBUTING.md` for the contributor workflow.
