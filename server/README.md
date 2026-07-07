# CountRoster server (Go)

The CountRoster backend: a REST API over a single SQLite file, compiled —
together with the built PWA — into **one static binary**. It is a faithful
port of the original TypeScript `@countroster/core` + Express `apps/server`
pair: same endpoints, same JSON shapes, same SQL schema, same on-disk SQLite
format, same backup-bundle format. A client (or a database file, or a backup
zip) can't tell the implementations apart.

## Build & run

```bash
cd server
go build -o bin/countroster ./cmd/countroster   # Go >= 1.21 bootstraps; go.mod pins the toolchain
./bin/countroster                               # API on http://localhost:8787
./bin/countroster serve --port 9000             # same thing, on a chosen port
```

## CLI

```
countroster [serve] [flags]   start the server (default command)
countroster version           print version and exit
countroster help              show usage
```

`serve` is the default, so a bare `countroster` still starts the server. Each
serve flag overrides the matching environment variable below; an unset flag
falls back to the env var, then the built-in default (**flag > env > default**).

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--port` | `PORT` | `8787` | listen port |
| `--host` | `HOST` | `0.0.0.0` | bind address |
| `--db` | `COUNTROSTER_DB` | `./data/countroster.sqlite` | SQLite file (`:memory:` honored as the SQLite sentinel) |
| `--web-dist` | `WEB_DIST` | — | serve the PWA from this directory (overrides embedded assets) |

`countroster serve -h` lists the flags; `--version` (or the `version`
subcommand) prints the version and exits.

The web client is resolved in order: `WEB_DIST` → assets embedded at build
time → `apps/web/dist` relative to the working directory. To embed, copy the
built PWA in before compiling (this is what `scripts/quickstart.sh` does):

```bash
cp -r ../apps/web/dist/. cmd/countroster/webdist/
CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o bin/countroster ./cmd/countroster
```

`CGO_ENABLED=0` works because the SQLite driver (`modernc.org/sqlite`) is pure
Go — the result is a fully static binary, cross-compilable with plain
`GOOS`/`GOARCH`.

## Layout

```
cmd/countroster/     entrypoint: env, boot (open DB → migrate → serve), PWA serving + SPA fallback
internal/api/        the REST layer — route-for-route port of the old Express app
internal/core/       domain services (trackers, entries, notes, groups, stats), validation, periods
internal/migrate/    append-only schema migrations 001–004 + runner (SQL copied verbatim from the TS core)
internal/backup/     .countroster.zip export/import (manifest, all.json, CSVs) + golden fixtures
internal/jsjson/     JSON serializer byte-identical to JavaScript's JSON.stringify (see below)
internal/storage/    the 4-method SQLite Storage contract (Exec/Query/Transaction/Close)
internal/ids/        UUIDv7 (time-sortable, monotonic within a millisecond)
internal/timeutil/   injected Clock; ISO 8601 local-offset timestamps
```

## Contracts that must not drift

- **The REST wire format.** The PWA (`apps/web/src/api/client.ts`) is compiled
  against it: snake_case field names, `0 | 1` integer flags, explicit `null`s,
  the `{"error": …}` error body, status codes 201/204/400/404/409.
  `internal/api/api_test.go` pins all of it.
- **The SQL schema and file format.** Migrations are append-only; never edit a
  shipped one. The Go server must keep opening databases written by the old
  Node server (and vice versa across a quickstart rollback).
- **The backup checksum canonicalization.** The manifest's `checksums.tables`
  is SHA-256 over `JSON.stringify(tables)` as JavaScript produced it. That's
  why `internal/jsjson` exists: ECMAScript `Number::toString` formatting
  (shortest round-trip digits, exponent notation only for |x| ≥ 1e21 or
  < 1e-6), minimal string escaping, and insertion-ordered object keys.
  `internal/backup/testdata/node-bundle.zip` was exported by the TypeScript
  implementation; `TestImportsNodeBundle` proves bundles round-trip across
  implementations with checksums intact. Regenerate fixtures only if the
  bundle format itself changes (and then bump `format_version`).
- **Timestamps.** Persisted timestamps are ISO 8601 with the *local* offset
  (never bare UTC "Z") via the injected `Clock`; never call `time.Now()`
  directly in domain code. Range comparisons in SQL go through `julianday()`
  so mixed offsets compare as instants.

## Tests

```bash
go test ./...
```

The suites port the original vitest suites one-for-one (trackers, entries,
notes, groups, hidden, derived, snapshot, derived-snapshot, stats, periods,
migrations, backup) plus the API integration suite, and add the
cross-implementation golden-fixture tests.
