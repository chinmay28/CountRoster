# CountRoster — User & API Guide

This guide has two halves:

- **[Part 1 — Feature guide](#part-1--feature-guide)** explains what CountRoster
  can do and how the pieces fit together, at a conceptual level.
- **[Part 2 — REST API reference](#part-2--rest-api-reference)** documents every
  endpoint exhaustively, with request/response shapes and `curl` examples.

For the architecture behind all of this, see [`DESIGN.md`](./DESIGN.md); for
running a server, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

> **Where the API lives.** Every client talks to one backend over HTTP. All routes
> below are rooted at `/api` on the server (default `http://localhost:8787`). The
> examples assume a `BASE` like:
>
> ```bash
> BASE=http://localhost:8787/api
> ```

---

## Part 1 — Feature guide

### 1.1 Trackers

A **tracker** is the definition of a thing you're counting or logging. Every
tracker has a **kind** that fixes what its numeric `value` means:

| Kind | What `value` means | Typical use |
|---|---|---|
| `count` | An increment, usually `1` | "Glasses of water", "Cigarettes" — tap to add one |
| `number` | The number you recorded | Weight, dollars spent, cups of coffee |
| `duration` | A number of **seconds** | Time meditated, time exercised |
| `boolean` | `0` or `1` | "Took meds today?" — one entry per day |
| `choice` | The numeric value of a chosen option | Mood (happy/ok/sad mapped to numbers) |

Beyond `kind`, a tracker carries presentation and behavior settings: `name`,
`description`, `color` (a 6-digit hex like `#4ECDC4`), `icon`, `unit` (e.g.
`"mg"`), a `default_value` used by quick-tap logging, and a `sort_order` for the
roster.

**Targets and reset periods.** A tracker can have a `target` (a goal value) and a
`reset_period` (`never` / `daily` / `weekly` / `monthly` / `yearly`). Together they
drive *target progress*: e.g. a target of `8` with `reset_period: "daily"` means
"8 per day", and progress resets each day. `week_start` (0 = Sunday, 1 = Monday)
controls where weekly periods begin. `day_start_minute` is reserved for a future
"my day starts at 4 AM" feature (see [DESIGN Appendix B](./DESIGN.md#appendix-b--period-bucketing-semantics-target)).

**Archiving vs. deleting.** Archiving (`archived_at` is set) takes a tracker off
the active roster but keeps all its data and lets you bring it back. Deleting
removes the tracker and cascades to its entries, notes, reminders, and group
memberships. Both are blocked with a `409` if the tracker is still a **source** of
a derived tracker (§1.3).

### 1.2 Entries: logging, custom values, and backdating

An **entry** is one logged event: a `value` at an `occurred_at` timestamp.

- **Quick-tap log.** Logging with no value uses the tracker's `default_value`
  (usually `1`) at the current time. This is the one-tap "+1" flow.
- **Custom value.** Supply `value` to record a specific number (e.g. a weight).
- **Backdating.** Supply `occurred_at` to log something that happened earlier, or
  `PATCH` an existing entry's `occurred_at` to move it. `occurred_at` is when the
  thing *happened*; `created_at` records when the row was written, so the two
  differ for backdated entries.
- **Batch logging.** A single atomic call can log many entries at once, even
  across different trackers — all succeed or none do (§2.3).

Entries are hard-deleted; there is no entry edit log (that's reserved for notes).

### 1.3 Derived trackers

A **derived tracker** has no entries of its own — its value is *computed* from
other trackers as a weighted sum. Each operand is a **link**: a `source_id` plus a
`coefficient`.

> `Profit = (+1 × Revenue) + (−1 × Expenses)` is a derived tracker with two links:
> `{source: Revenue, coefficient: 1}` and `{source: Expenses, coefficient: -1}`.

Because every aggregation in CountRoster is a sum, the weighted combination works
across any range, bucket, streak, or target — a derived tracker charts and reports
exactly like an ordinary one. Rules:

- You **cannot log directly** to a derived tracker (`400 DerivedTrackerError`).
- Sources must exist, must be **ordinary** (no deriving from a derived tracker),
  can't include the tracker itself, and can't repeat.
- A source tracker **can't be archived or deleted** while a derivation still uses
  it (`409 TrackerInUseError`, naming the dependents) — remove or unlink them first.
- Derivations may **not mix hidden and visible** sources (§1.4).
- Setting a tracker's links to a non-empty list makes it derived; setting them to
  an empty list makes it ordinary again.

You create a derived tracker by passing `links` to `POST /trackers`, or convert one
later with `PUT /trackers/:id/links`.

### 1.4 Hidden mode

A **hidden** tracker (`is_hidden: 1`) is excluded from the roster entirely unless
the caller explicitly opts in with `?includeHidden=1`. The PWA only opts in once
the user unlocks "hidden mode", giving a lightweight way to keep private trackers
off the default view. Hiding is **orthogonal to archiving**: an archived tracker is
off the roster but still discoverable; a hidden one is invisible until you ask for
it. A derivation can't span the hidden/visible boundary.

### 1.5 Groups

A **group** is an optional, ordered collection of trackers for organizing the home
screen (e.g. "Health", "Finance"). A tracker can belong to multiple groups.
Membership and group order are both reorderable, and adding a tracker that's
already a member is a no-op.

### 1.6 Notes and the edit history

A **note** is free-text journal text attached to a tracker, and optionally to a
specific entry (`entry_id`). Notes have their own `occurred_at` so they sit on the
timeline.

The distinguishing feature is the **append-only edit log**: when you edit a note's
body, the *previous* body is saved to history before the row is updated (editing to
the same text is a no-op). `GET /notes/:id/history` returns those prior versions,
so a note's full change history is always recoverable. Notes are hard-deleted, and
deleting a note removes its history.

### 1.7 Reminders

A **reminder** is a per-tracker schedule: a `time_minute` (minutes after local
midnight, so `480` = 8:00 AM), a `days_mask` (a 7-bit bitmask, bit 0 = Sunday …
bit 6 = Saturday; `127` = every day), and an `enabled` flag. The schema and full
CRUD + a quick toggle exist server-side; actually *delivering* notifications is a
client/platform concern (see DESIGN roadmap).

### 1.8 Statistics

Three read-only stats are computed from a tracker's effective entries (real ones,
or virtual ones for a derived tracker):

- **Buckets** — sum entry values into `day` / `week` / `month` / `year` buckets
  across a date range. Empty buckets are returned as zeroes so charts have no
  gaps. Each bucket reports both the summed `value` and the `count` of entries.
- **Streak** — the current and longest runs of consecutive calendar days with at
  least one entry. The current streak counts back from today (or yesterday, if you
  haven't logged today yet).
- **Target progress** — the sum within the tracker's current reset period and the
  `ratio` toward its `target` (clamped to `[0, 1]`; `null` if there's no target).

> Bucketing currently uses host-local-time date math and does not yet honor
> `day_start_minute` or a per-tracker timezone — see [DESIGN Appendix B](./DESIGN.md#appendix-b--period-bucketing-semantics-target).

### 1.9 Backup, restore, and export

CountRoster's data is fully portable:

- **Bundle** (`.countroster.zip`) — a `manifest.json`, an `all.json` full dump, and
  one CSV per table. The `all.json` is the restorable artifact; the CSVs are for
  spreadsheets. Integrity is protected by a SHA-256 over the table payload.
- **Raw SQLite** — a byte-for-byte download of the database file (unavailable for an
  in-memory dev server).
- **Restore** — upload a bundle to replace the database contents in one
  transaction. A bundle from an **older** schema restores fine (missing columns
  fall back to defaults); a bundle from a **newer** schema is refused. By default a
  restore refuses to overwrite a non-empty database unless you pass
  `?confirmOverwrite=1`.

### 1.10 The PWA client

The web client (`apps/web`) is an installable Progressive Web App: open it over
HTTPS (or `http://localhost`) and use the browser's **Install** / **Add to Home
Screen** prompt to run it in its own window on desktop or mobile. It holds no data
of its own — everything lives on the server — so reinstalling loses nothing. It
ships home/roster, tracker create/edit, entry detail with backdating, notes with
history, charts and a calendar heatmap, multi-tracker compare, groups, reminders,
derived trackers, hidden mode, and a Data page wrapping the backup endpoints.

---

## Part 2 — REST API reference

### 2.0 Conventions

- **Base path.** All endpoints are under `/api`.
- **Content type.** Request and response bodies are JSON (`Content-Type:
  application/json`), except the binary backup routes (zip / SQLite / raw upload).
- **No auth.** There are no tokens or headers to send — the server is meant to run
  on a trusted network.
- **IDs** are UUIDv7 strings (time-sortable).
- **Timestamps** are ISO 8601 **with an offset**, e.g. `2026-05-25T14:32:00-07:00`
  (not bare `Z`-only UTC). Inputs that accept a timestamp require the offset.
- **Status codes:**

  | Code | Meaning |
  |---|---|
  | `200` | OK (reads, updates, toggles) |
  | `201` | Created (POST that creates a row) |
  | `204` | No Content (archive/unarchive, delete, reorder, group membership changes) |
  | `400` | Validation failed (`ZodError`) or invalid derivation (`DerivedTrackerError`) |
  | `404` | Resource not found |
  | `409` | Conflict — tracker still in use by a derivation (`TrackerInUseError`) |
  | `500` | Unhandled server error |
  | `501` | Raw SQLite export requested against an in-memory database |

- **Error body.** Errors return `{ "error": "<message>" }`. Validation errors also
  include the Zod issue list: `{ "error": "Validation failed", "issues": [...] }`.

---

### 2.1 Trackers

#### Tracker object

```jsonc
{
  "id": "0190a1b2-...",
  "name": "Water",
  "description": null,
  "color": "#4ECDC4",
  "icon": null,
  "kind": "count",                 // count | number | duration | boolean | choice
  "unit": null,
  "target": 8,
  "reset_period": "daily",         // never | daily | weekly | monthly | yearly
  "week_start": 1,                 // 0 = Sunday, 1 = Monday
  "day_start_minute": 0,           // 0..1439
  "default_value": 1,
  "archived_at": null,             // ISO timestamp, or null when active
  "sort_order": 0,
  "is_derived": 0,                 // 0 | 1
  "is_hidden": 0,                  // 0 | 1
  "created_at": "2026-05-25T12:00:00-07:00",
  "updated_at": "2026-05-25T12:00:00-07:00"
}
```

#### Create input fields (`POST`/`PATCH`)

| Field | Type | Rules / default |
|---|---|---|
| `name` | string | required on create; trimmed, 1–120 chars |
| `description` | string \| null | ≤ 2000 chars |
| `color` | string | 6-digit hex `#rrggbb`; default `#888888` |
| `icon` | string \| null | ≤ 60 chars |
| `kind` | enum | one of the five kinds; default `count` |
| `unit` | string \| null | ≤ 30 chars |
| `target` | number \| null | finite |
| `reset_period` | enum | default `never` |
| `week_start` | `0` \| `1` | default `1` |
| `day_start_minute` | int | 0–1439; default `0` |
| `default_value` | number | finite; default `1` |
| `sort_order` | int | default `0` |
| `is_hidden` | `0` \| `1` | default `0` |
| `links` | array | optional; up to 50 `{ source_id, coefficient }` — makes the tracker derived |

`PATCH` accepts the same fields, all optional. Supplying `links` on update fully
replaces the existing links (empty list ⇒ ordinary tracker).

#### Endpoints

| Method & path | Description | Success |
|---|---|---|
| `GET /trackers` | List trackers. Query: `includeArchived=1`, `includeHidden=1`. | `200` `Tracker[]` |
| `POST /trackers` | Create a tracker. | `201` `Tracker` |
| `GET /trackers/:id` | Fetch one. | `200` `Tracker` / `404` |
| `PATCH /trackers/:id` | Update fields. | `200` `Tracker` |
| `DELETE /trackers/:id` | Delete (cascades to entries/notes/reminders/memberships). | `204` / `409` |
| `POST /trackers/:id/archive` | Soft-archive. | `204` / `409` |
| `POST /trackers/:id/unarchive` | Restore from archive. | `204` |
| `POST /trackers/reorder` | Set roster order. Body: `{ "orderedIds": ["id1","id2",...] }`. | `204` |
| `GET /trackers/:id/links` | List a derived tracker's operands. | `200` `TrackerLink[]` |
| `PUT /trackers/:id/links` | Replace operands. Body: `{ "links": [{ "source_id": "...", "coefficient": -1 }] }`. | `200` `TrackerLink[]` |

#### Examples

```bash
# Create a daily "Water" count tracker with a target of 8
curl -s -X POST "$BASE/trackers" -H 'Content-Type: application/json' -d '{
  "name": "Water", "kind": "count", "color": "#4ECDC4",
  "target": 8, "reset_period": "daily", "default_value": 1
}'

# List active, visible trackers
curl -s "$BASE/trackers"

# Include archived and hidden
curl -s "$BASE/trackers?includeArchived=1&includeHidden=1"

# Rename and recolor
curl -s -X PATCH "$BASE/trackers/$ID" -H 'Content-Type: application/json' \
  -d '{ "name": "Hydration", "color": "#1E88E5" }'

# Reorder the roster
curl -s -X POST "$BASE/trackers/reorder" -H 'Content-Type: application/json' \
  -d '{ "orderedIds": ["'$A'", "'$B'", "'$C'"] }'

# Make "Profit" derived from Revenue (+1) and Expenses (-1)
curl -s -X PUT "$BASE/trackers/$PROFIT/links" -H 'Content-Type: application/json' -d '{
  "links": [
    { "source_id": "'$REVENUE'",  "coefficient": 1 },
    { "source_id": "'$EXPENSES'", "coefficient": -1 }
  ]
}'

# Archive (fails with 409 if it is a derivation source)
curl -s -X POST "$BASE/trackers/$ID/archive"
```

`TrackerLink` shape:

```jsonc
{ "id": "...", "tracker_id": "<derived>", "source_id": "<source>",
  "coefficient": -1, "sort_order": 0, "created_at": "..." }
```

---

### 2.2 Entries

#### Entry object

```jsonc
{
  "id": "...",
  "tracker_id": "...",
  "value": 1,
  "occurred_at": "2026-05-25T09:15:00-07:00",  // when it happened (may be backdated)
  "created_at":  "2026-05-25T09:15:02-07:00",  // when the row was written
  "updated_at":  "2026-05-25T09:15:02-07:00"
}
```

#### Endpoints

| Method & path | Description | Success |
|---|---|---|
| `GET /trackers/:id/entries` | Entries for a tracker. Query: `start`, `end` (ISO; `start` inclusive, `end` exclusive). | `200` `Entry[]` |
| `POST /trackers/:id/entries` | Log one entry. Body: `{ value?, occurred_at? }`. | `201` `Entry` |
| `POST /entries/batch` | Atomic batch log across trackers. Body: array of `{ tracker_id, value?, occurred_at? }` (1–500 items). | `201` `Entry[]` |
| `GET /entries/:id` | Fetch one. | `200` `Entry` / `404` |
| `PATCH /entries/:id` | Edit `value` and/or `occurred_at`. | `200` `Entry` |
| `DELETE /entries/:id` | Hard-delete. | `204` |

Logging defaults: omit `value` to use the tracker's `default_value`; omit
`occurred_at` to use now. Logging to a derived tracker returns `400`.

#### Examples

```bash
# Quick-tap: +1 at now
curl -s -X POST "$BASE/trackers/$WATER/entries" -H 'Content-Type: application/json' -d '{}'

# Record a custom number (e.g. weight)
curl -s -X POST "$BASE/trackers/$WEIGHT/entries" -H 'Content-Type: application/json' \
  -d '{ "value": 72.4 }'

# Backdate an entry to yesterday morning
curl -s -X POST "$BASE/trackers/$WATER/entries" -H 'Content-Type: application/json' \
  -d '{ "value": 1, "occurred_at": "2026-05-24T08:00:00-07:00" }'

# Batch-log across two trackers, atomically
curl -s -X POST "$BASE/entries/batch" -H 'Content-Type: application/json' -d '[
  { "tracker_id": "'$WATER'",  "value": 1 },
  { "tracker_id": "'$COFFEE'", "value": 2, "occurred_at": "2026-05-25T07:30:00-07:00" }
]'

# Entries in a date window
curl -s "$BASE/trackers/$WATER/entries?start=2026-05-01T00:00:00-07:00&end=2026-06-01T00:00:00-07:00"

# Move an entry's timestamp (re-bucket it)
curl -s -X PATCH "$BASE/entries/$EID" -H 'Content-Type: application/json' \
  -d '{ "occurred_at": "2026-05-20T12:00:00-07:00" }'
```

---

### 2.3 Notes

#### Note object

```jsonc
{
  "id": "...",
  "tracker_id": "...",
  "entry_id": null,            // or an entry id when attached to one
  "body": "Felt better after a walk.",
  "occurred_at": "2026-05-25T20:00:00-07:00",
  "created_at": "...",
  "updated_at": "..."
}
```

`NoteEdit` (history) object:

```jsonc
{ "id": "...", "note_id": "...", "prev_body": "Felt off today.", "edited_at": "..." }
```

#### Endpoints

| Method & path | Description | Success |
|---|---|---|
| `GET /trackers/:id/notes` | Notes for a tracker. Query: `start`, `end`. | `200` `Note[]` |
| `POST /notes` | Create. Body: `{ tracker_id, body, entry_id?, occurred_at? }`. `body` ≤ 100 000 chars. | `201` `Note` |
| `PATCH /notes/:id` | Edit `body` and/or `occurred_at`. A body change appends the old body to history. | `200` `Note` |
| `GET /notes/:id/history` | Prior versions, oldest→newest. | `200` `NoteEdit[]` |
| `DELETE /notes/:id` | Hard-delete (drops history too). | `204` |

#### Examples

```bash
# Standalone note on a tracker
curl -s -X POST "$BASE/notes" -H 'Content-Type: application/json' -d '{
  "tracker_id": "'$MOOD'", "body": "Rough morning, better by evening."
}'

# Note attached to a specific entry
curl -s -X POST "$BASE/notes" -H 'Content-Type: application/json' -d '{
  "tracker_id": "'$MOOD'", "entry_id": "'$EID'", "body": "Logged after lunch."
}'

# Edit the body (previous text is saved to history)
curl -s -X PATCH "$BASE/notes/$NID" -H 'Content-Type: application/json' \
  -d '{ "body": "Rough morning; much better after a walk." }'

# See every prior version
curl -s "$BASE/notes/$NID/history"
```

---

### 2.4 Groups

#### Group object

```jsonc
{ "id": "...", "name": "Health", "color": "#FF6B6B",
  "sort_order": 0, "created_at": "...", "updated_at": "..." }
```

#### Endpoints

| Method & path | Description | Success |
|---|---|---|
| `GET /groups` | List groups in order. | `200` `TrackerGroup[]` |
| `POST /groups` | Create. Body: `{ name, color?, sort_order? }`. | `201` `TrackerGroup` |
| `GET /groups/:id` | Fetch one. | `200` / `404` |
| `PATCH /groups/:id` | Update fields. | `200` `TrackerGroup` |
| `DELETE /groups/:id` | Delete the group (trackers themselves are untouched). | `204` |
| `POST /groups/reorder` | Order groups. Body: `{ "orderedGroupIds": [...] }`. | `204` |
| `GET /groups/:id/trackers` | Member trackers, in membership order. | `200` `Tracker[]` |
| `POST /groups/:id/trackers` | Add a member (idempotent). Body: `{ "tracker_id": "..." }`. | `204` |
| `DELETE /groups/:id/trackers/:trackerId` | Remove a member (no-op if absent). | `204` |
| `POST /groups/:id/reorder` | Order members. Body: `{ "orderedTrackerIds": [...] }`. | `204` |

#### Examples

```bash
# Create a group and add two trackers
GID=$(curl -s -X POST "$BASE/groups" -H 'Content-Type: application/json' \
  -d '{ "name": "Health", "color": "#FF6B6B" }' | jq -r .id)
curl -s -X POST "$BASE/groups/$GID/trackers" -H 'Content-Type: application/json' \
  -d '{ "tracker_id": "'$WATER'" }'
curl -s -X POST "$BASE/groups/$GID/trackers" -H 'Content-Type: application/json' \
  -d '{ "tracker_id": "'$STEPS'" }'

# Reorder members within the group
curl -s -X POST "$BASE/groups/$GID/reorder" -H 'Content-Type: application/json' \
  -d '{ "orderedTrackerIds": ["'$STEPS'", "'$WATER'"] }'

# Remove a tracker from the group
curl -s -X DELETE "$BASE/groups/$GID/trackers/$WATER"
```

---

### 2.5 Reminders

#### Reminder object

```jsonc
{
  "id": "...",
  "tracker_id": "...",
  "time_minute": 480,   // minutes after local midnight (480 = 08:00)
  "days_mask": 127,     // bit 0=Sun ... bit 6=Sat; 127 = every day
  "enabled": 1,         // 0 | 1
  "created_at": "...",
  "updated_at": "..."
}
```

#### Endpoints

| Method & path | Description | Success |
|---|---|---|
| `GET /trackers/:id/reminders` | Reminders for a tracker. | `200` `Reminder[]` |
| `POST /reminders` | Create. Body: `{ tracker_id, time_minute, days_mask?, enabled? }`. | `201` `Reminder` |
| `GET /reminders/:id` | Fetch one. | `200` / `404` |
| `PATCH /reminders/:id` | Update `time_minute` / `days_mask` / `enabled` (tracker is immutable). | `200` `Reminder` |
| `POST /reminders/:id/toggle` | Set enabled. Body: `{ "enabled": true }`. | `200` `Reminder` |
| `DELETE /reminders/:id` | Delete. | `204` |

Field rules: `time_minute` 0–1439; `days_mask` 0–127 (default 127); `enabled` `0`/`1`
(default 1).

#### Examples

```bash
# Weekday 8:00 AM reminder. Mon–Fri = bits 1..5 = 2+4+8+16+32 = 62
curl -s -X POST "$BASE/reminders" -H 'Content-Type: application/json' -d '{
  "tracker_id": "'$MEDS'", "time_minute": 480, "days_mask": 62
}'

# Pause it without deleting
curl -s -X POST "$BASE/reminders/$RID/toggle" -H 'Content-Type: application/json' \
  -d '{ "enabled": false }'

# Move it to 9:30 PM (21*60 + 30 = 1290)
curl -s -X PATCH "$BASE/reminders/$RID" -H 'Content-Type: application/json' \
  -d '{ "time_minute": 1290 }'
```

> **`days_mask` cheat sheet:** Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64.
> Weekdays = 62, weekends = 65, every day = 127.

---

### 2.6 Statistics

All three are computed over the tracker's *effective* entries (virtual entries for
derived trackers).

#### `GET /trackers/:id/stats/buckets`

Sum values into period buckets across `[start, end)`.

| Query param | Required | Notes |
|---|---|---|
| `start` | yes | ISO timestamp, inclusive |
| `end` | yes | ISO timestamp, exclusive |
| `period` | no | `day` (default) \| `week` \| `month` \| `year` |

Response — `StatBucket[]`, one per period in range (zeroes for empty periods):

```jsonc
[
  { "start": "2026-05-01T00:00:00.000Z", "end": "2026-05-02T00:00:00.000Z",
    "label": "2026-05-01", "value": 6, "count": 6 },
  { "start": "...", "end": "...", "label": "2026-05-02", "value": 0, "count": 0 }
]
```

Labels: `YYYY-MM-DD` (day), `YYYY-Www` (week), `YYYY-MM` (month), `YYYY` (year).

```bash
curl -s "$BASE/trackers/$WATER/stats/buckets?start=2026-05-01T00:00:00-07:00&end=2026-06-01T00:00:00-07:00&period=day"
```

#### `GET /trackers/:id/stats/streak`

```jsonc
{ "current": 4, "longest": 11 }
```

Consecutive-calendar-day runs of logging. `current` counts back from today, or from
yesterday if today has no entry yet.

```bash
curl -s "$BASE/trackers/$WATER/stats/streak"
```

#### `GET /trackers/:id/stats/target-progress`

Progress within the current reset period. Query `at` (ISO) evaluates progress as of
a specific instant; omit it for "now".

```jsonc
{ "target": 8, "current": 5, "ratio": 0.625 }
```

`ratio` is `current/target` clamped to `[0, 1]`, or `null` when the tracker has no
target. For `reset_period: "never"`, `current` is the all-time sum.

```bash
curl -s "$BASE/trackers/$WATER/stats/target-progress"
curl -s "$BASE/trackers/$WATER/stats/target-progress?at=2026-05-20T23:59:59-07:00"
```

---

### 2.7 Backup, restore & export

#### `GET /backup/manifest`

Returns the manifest describing the current database without downloading the data.

```jsonc
{
  "format_version": 1,
  "app_version": "0.1.0",
  "schema_version": 3,
  "exported_at": "2026-05-25T14:32:00-07:00",
  "row_counts": { "trackers": 12, "entries": 4831, "notes": 217, "...": 0 },
  "checksums": { "tables": "sha256:..." }
}
```

#### `GET /backup/bundle`

Streams a `.countroster.zip` (`Content-Type: application/zip`, with a
`Content-Disposition` filename `countroster-YYYY-MM-DD.countroster.zip`). Contains
`manifest.json`, `all.json`, and `exports/<table>.csv`.

```bash
curl -s "$BASE/backup/bundle" -o backup.countroster.zip
```

#### `GET /backup/sqlite`

Streams the raw on-disk SQLite file. Returns `501` if the server is running an
in-memory database.

```bash
curl -s "$BASE/backup/sqlite" -o countroster.sqlite
```

#### `POST /backup/import`

Uploads a bundle (the **raw zip bytes** as the request body) and replaces the
database contents in a single transaction.

| Query param | Notes |
|---|---|
| `confirmOverwrite=1` | Required to overwrite a database that already has trackers. Without it, a non-empty DB is left untouched and the call errors. |

Validation: rejects a mismatched `format_version`, a `schema_version` newer than the
running server, or a failed tables checksum.

Response — `ImportResult`:

```jsonc
{ "imported_rows": { "trackers": 12, "entries": 4831, "...": 0 }, "schema_version": 3 }
```

```bash
# Restore, overwriting existing data
curl -s -X POST "$BASE/backup/import?confirmOverwrite=1" \
  --data-binary @backup.countroster.zip
```

---

### 2.8 Health

#### `GET /health`

```jsonc
{ "ok": true, "version": "0.1.0" }
```

```bash
curl -s "$BASE/health"
```

Useful as a liveness/readiness probe — the systemd quickstart polls it to decide
whether to roll an upgrade back (see [`DEPLOYMENT.md`](./DEPLOYMENT.md)).

---

## Appendix — end-to-end walkthrough

```bash
BASE=http://localhost:8787/api

# 1. Create a tracker
WATER=$(curl -s -X POST "$BASE/trackers" -H 'Content-Type: application/json' \
  -d '{ "name":"Water","kind":"count","target":8,"reset_period":"daily" }' | jq -r .id)

# 2. Log a few entries
curl -s -X POST "$BASE/trackers/$WATER/entries" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "$BASE/trackers/$WATER/entries" -H 'Content-Type: application/json' -d '{}'

# 3. Check progress toward today's target of 8
curl -s "$BASE/trackers/$WATER/stats/target-progress"
# → { "target": 8, "current": 2, "ratio": 0.25 }

# 4. Add a note
curl -s -X POST "$BASE/notes" -H 'Content-Type: application/json' \
  -d '{ "tracker_id":"'$WATER'", "body":"Trying to hit 8 today." }'

# 5. Back it all up
curl -s "$BASE/backup/bundle" -o backup.countroster.zip
```
