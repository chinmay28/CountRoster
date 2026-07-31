# Changelog

Releases are `vMAJOR.MINOR.PATCH`, where the patch number is the repository's
commit count — `v1.1.98` is the 98th commit on the 1.1 line. See
[`server/internal/version/version.go`](./server/internal/version/version.go).

Each section below is the body of the corresponding GitHub release;
[`.github/workflows/release.yml`](./.github/workflows/release.yml) reads it
straight out of this file when a `v*` tag is pushed, and appends the
auto-generated commit list under it.

## v1.1.98 — Go server, spending imports, custom fields, cloud backup

The first release since `v1.0.0`, and the largest change in the project's life:
the backend was **rewritten in Go**, so a deployment is now one static binary
with the PWA baked in — no Node, no `node_modules`, no runtime dependencies at
all. The REST API, SQL schema, on-disk SQLite file, and backup format are
bit-compatible with the TypeScript server, so an existing install upgrades in
place and opens the same database file it already had.

On top of that: credit-card spending imports, custom fields per tracker,
custom period windows, a phone-sized quick-log screen installable on its own,
and automatic backup to Dropbox or Google Drive.

**Downloads.** This release ships a prebuilt **`linux/arm64`** binary
(`countroster-linux-arm64`, with a `.sha256` beside it) — a static, CGO-free
executable with the web client embedded. Raspberry Pi and arm64 VM users can now
install without a toolchain:

```bash
curl -fsSL https://raw.githubusercontent.com/chinmay28/countroster/main/scripts/quickstart.sh \
  | sudo COUNTROSTER_INSTALL=release bash
```

Other architectures keep building from source (the default) — the quick start
is unchanged for them.

### The server is now Go

- **Rewrote the backend in Go: one static binary, zero contract changes**
  (#52). Domain services, migrations, stats, backup, and the HTTP layer all
  moved to `server/`, over `modernc.org/sqlite` (pure Go, so `CGO_ENABLED=0`
  yields a fully static binary). The API test suite pins the wire contract —
  snake_case fields, `0 | 1` flags, the same status codes — and the PWA was not
  changed at all. The binary embeds the built PWA and serves it from the same
  origin, so production is one process and no CORS.
- **`countroster serve` subcommand with real CLI flags** (#55): `--host`,
  `--port`, `--db`, `--web-dist`, each overriding its env-var fallback, plus
  `countroster version`.
- **Web tooling: npm audit fixes and deprecation cleanup** (#54).

### Track spending: credit-card imports

- **Import, review, and auto-categorize credit-card transactions** (#56). Drop
  in a CSV, review what it found, and file rows against trackers; learned rules
  categorize the obvious ones next time.
- **Real-world CSV shapes**: Empower's title line above the header and its
  `Firm Name` column (#57), plus **Chase and US Bank** exports (#61).
- **Review-queue ergonomics** (#58, #59): undo for a row you just filed, delete
  and clear for dismissed rows, `Clear all` to drop a whole import, and a fix
  for the table overflowing on a phone.

### Custom fields, and periods that match your day

- **Custom fields per tracker** (#72). A tracker's value is *how much*; a field
  records anything else worth keeping per entry — `choice`, `flag`, `number`, or
  `text`. A choice answer is a real foreign key, so it can be renamed without
  orphaning the entries filed against it. No field is ever mandatory by design,
  so adding one never invalidates entries logged before it.
- **Custom period windows** (#71): a day can run 7:00 AM → 6:59 AM, a month the
  8th → the 7th, a year April → March. Totals, streaks, and charts all bucket by
  the tracker's own window.
- **Read a tracker by its periods** (#73): three entry views and reorderable
  detail sections.
- **Step through reset windows** from the current-window tab, with the latest
  window on the left (#86, #87).
- Entry-field layout: two centred columns (#75), and the entry table's
  *Answers* merged into one *Notes* column (#76).

### A quick-log screen for phones

- **A dedicated per-tracker quick-log screen** (#64), **installable as its own
  Home Screen app** (#65) — one tap from the home screen to one tracker's keypad.
- Backdating from the quick screen (#67), swapped Home/Details links (#68), and
  three fixes for how iOS resolves an installed app's start URL and service
  worker (#66, #69, #70).
- Hidden mode now stays unlocked across the quick-log screen (#79).

### Automatic cloud backup

- **Back up automatically to a Dropbox or Google Drive folder** (#83) on an
  `hourly | daily | weekly | monthly` schedule — the same `.countroster.zip`
  bundle the Data page exports. `next_run_at` lives in the database, so a server
  that was off over its deadline picks the run up on the next tick.
- **Set it up from the Data page, and connect Dropbox without a redirect**
  (#84). Each deployment registers its own OAuth app (a self-hosted server has
  no predictable redirect URI), and the paste-a-code flow exists for LAN servers
  that have no https origin at all. Tokens live only in the server's SQLite
  file: they are redacted from the API and deliberately excluded from the backup
  bundle, so an export is never also a credential file.

### Versioning

- **The app now versions itself `vMAJOR.MINOR.<commit count>`** (#77), shown in
  the header, printed by `countroster version`, returned by `/api/health`, and
  recorded in backup manifests.
- **A shallow clone no longer reports a fake patch number** (#78) — it reports
  `0`, the "unstamped build" marker, and the quick start clones with
  `--filter=blob:none` so the count is real.

### Smaller changes and fixes

- Derived snapshot trends plot one settled point per instant (#62) and collapse
  per day rather than per instant (#63).
- A new tracker defaults to the number kind (#80).
- A developer badge in the header, signed with the developer's GitHub handle
  (#81, #82).
- The "when" picker opens in place, and the total is paced against yesterday
  (#85).
- Fixed horizontal panning on the mobile home screen (#60), and kept the
  tracker-card total clear of the corner log button (#53).
- Removed the quick-add preset chips from the keypad panel (#74).

## v1.0.0 — Pure TypeScript web app

See the [v1.0.0 release notes](https://github.com/chinmay28/countroster/releases/tag/v1.0.0).
