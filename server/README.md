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

A bare `go build` reports version `v1.1.0` — patch **0** marks an unstamped dev
build. Releases get the real patch number (the commit count) stamped in; see
[Version](#version) below.

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
| `--dropbox-client-id` | `COUNTROSTER_DROPBOX_CLIENT_ID` | — | Dropbox OAuth app key; enables cloud backup to Dropbox |
| `--dropbox-client-secret` | `COUNTROSTER_DROPBOX_CLIENT_SECRET` | — | Dropbox app secret (omit for a PKCE-only app) |
| `--google-client-id` | `COUNTROSTER_GOOGLE_CLIENT_ID` | — | Google OAuth client id; enables cloud backup to Google Drive |
| `--google-client-secret` | `COUNTROSTER_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `--public-url` | `COUNTROSTER_PUBLIC_URL` | request origin | origin the OAuth redirect URI is built from |

`countroster serve -h` lists the flags; `--version` (or the `version`
subcommand) prints the version and exits.

The web client is resolved in order: `--web-dist` (env `WEB_DIST`) → assets
embedded at build time → `apps/web/dist` relative to the working directory. To embed, copy the
built PWA in before compiling (this is what `scripts/quickstart.sh` does):

```bash
cp -r ../apps/web/dist/. cmd/countroster/webdist/
CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X github.com/chinmay28/countroster/server/internal/version.Patch=$(node ../scripts/version.mjs --patch)" \
  -o bin/countroster ./cmd/countroster
```

`CGO_ENABLED=0` works because the SQLite driver (`modernc.org/sqlite`) is pure
Go — the result is a fully static binary, cross-compilable with plain
`GOOS`/`GOARCH`.

## Version

`vMAJOR.MINOR.PATCH`, where the patch number is the repository's **commit
count** — every commit is a patch release, so `v1.1.311` is the 311th commit on
the 1.1 line. It's what `countroster version` prints, what `/api/health`
returns, what the backup manifest records as `app_version`, and what the PWA
shows under the wordmark in its header.

| Part | Source |
|---|---|
| Major, minor | `Major`/`Minor` consts in `internal/version/version.go`. Bump by hand. |
| Patch | `git rev-list --count HEAD`, stamped at link time — a binary has no repo to ask. |

The stamp is `-ldflags "-X .../internal/version.Patch=<count>"` (see the build
command above). Unstamped, `Patch` stays `"0"`: **patch 0 means a dev build**,
never a release.

**The count needs full history.** A `--depth 1` clone answers `rev-list --count
HEAD` with `1`, which is not an error — it's a build that calls itself `v1.1.1`.
`version.mjs` checks `rev-parse --is-shallow-repository` and reports 0 rather
than the fake count, so the failure shows up as an obviously-unstamped `v1.1.0`.
Clone with `--filter=blob:none` (whole commit graph, only the blobs the
checkout needs) rather than `--depth 1`, or `fetch-depth: 0` in CI.

`scripts/version.mjs` at the repo root is the one place the number is
assembled — it reads `Major`/`Minor` straight out of `version.go` and runs the
`git rev-list`. The Go build and the web build both call it, so the binary and
the bundle can't report different versions. Keep the two constants in a form
that file's regex still matches (`Major = 1` on its own line).

## Layout

```
cmd/countroster/     entrypoint: env, boot (open DB → migrate → serve), PWA serving + SPA fallback
internal/api/        the REST layer — route-for-route port of the old Express app
internal/core/       domain services (trackers, entries, notes, groups, stats), validation, periods
internal/migrate/    append-only schema migrations 001–004 + runner (SQL copied verbatim from the TS core)
internal/backup/     .countroster.zip export/import (manifest, all.json, CSVs) + golden fixtures
internal/cloud/      automatic cloud backup: OAuth to Dropbox / Google Drive, the schedule, the uploader
internal/jsjson/     JSON serializer byte-identical to JavaScript's JSON.stringify (see below)
internal/storage/    the 4-method SQLite Storage contract (Exec/Query/Transaction/Close)
internal/ids/        UUIDv7 (time-sortable, monotonic within a millisecond)
internal/timeutil/   injected Clock; ISO 8601 local-offset timestamps
```

## Automatic cloud backup

`internal/cloud` uploads the same `.countroster.zip` the download button
produces to a folder the user picked in their Dropbox or Google Drive, on an
hourly / daily / weekly / monthly schedule. The whole configuration is one
row (`cloud_backup_settings`, migration 009) and a goroutine that polls it
once a minute; `next_run_at` lives in the database, so a server that was off
over its deadline finds the run overdue when it comes back.

**Each deployment registers its own OAuth app.** A self-hosted server sits at
an address nobody can predict, and providers require every redirect URI to be
registered in advance — so there is no shipped identity that could cover every
install the way a store app's fixed `com.app://` scheme covers its own. The
client id is entered in the Data page (stored in `cloud_provider_credentials`,
migration 010) and the page shows `<origin>/api/cloud/backup/callback` to
register, with a Copy button. The `--dropbox-client-id` / `--google-client-id`
flags remain as the fallback for automated deployments; the settings row wins
when both exist. A provider with neither is listed with a **Set up** button
rather than a disabled one. See DEPLOYMENT.md §0.1.

The package splits three ways so only one part knows about a third party:
`Provider` (the OAuth dance, browsing folders, uploading bytes — one
implementation per service), `Service` (the settings row, token refresh, when
the next run is due), and `Scheduler` (the ticking goroutine). Tests run the
providers against `httptest` servers speaking each service's real dialect.

**Credentials never leave the server.** Tokens and client secrets are kept
out of every API response (`cloud.PublicSettings` is redacted), and
deliberately excluded from the backup bundle — an export is the documented
egress point and must not double as a credential file, and restoring a bundle
taken on another machine must not repoint this server at that machine's cloud
account.

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
