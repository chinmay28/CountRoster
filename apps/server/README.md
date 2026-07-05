# @countroster/server

The CountRoster backend — an Express REST API over [`@countroster/core`](../../packages/core),
backed by a single on-disk SQLite database. This is the shared source of truth for
every client.

- **Express 5**, ESM, `NodeNext` module resolution (the compiled `dist/` runs as
  real Node ESM).
- **`NodeSqliteAdapter`** (`src/db/adapter.ts`): the core's `Storage` contract over
  Node 22's built-in `node:sqlite`, file-backed. Same engine as the test adapter.
- **No auth.** Designed to run on a trusted network (LAN / Tailscale / VPN).

## Commands

```bash
npm run build --workspace @countroster/core    # build the core first (the server imports its dist/)
npm run dev   --workspace @countroster/server   # tsx watch — API on http://localhost:8787
npm run build --workspace @countroster/server   # tsc → dist/
npm run start --workspace @countroster/server   # node dist/server.js
npm run test  --workspace @countroster/server   # vitest API integration tests (boots against :memory:)
```

## Configuration (env vars)

| Var              | Default                      | Meaning                                            |
|------------------|------------------------------|----------------------------------------------------|
| `PORT`           | `8787`                       | Port to listen on.                                 |
| `HOST`           | `0.0.0.0`                    | Bind address.                                      |
| `COUNTROSTER_DB` | `./data/countroster.sqlite`  | SQLite file path. `:memory:` for an ephemeral DB.  |
| `WEB_DIST`       | `../web/dist` (relative to the built server) | Built PWA to serve. If present, the server hosts the client on the same origin with an SPA fallback. |

The DB directory is created on boot; migrations run automatically (open adapter →
`createApp` → `migrations.run()`).

## API shape

All routes are under `/api`. JSON in/out; errors are `{ error, issues? }` with
`400` for validation failures and `404` for unknown ids.

| Area      | Examples                                                                                  |
|-----------|-------------------------------------------------------------------------------------------|
| Trackers  | `GET/POST /trackers`, `GET/PATCH/DELETE /trackers/:id`, `POST /trackers/:id/{archive,unarchive}`, `POST /trackers/reorder` |
| Entries   | `GET/POST /trackers/:id/entries`, `GET/PATCH/DELETE /entries/:id`                          |
| Notes     | `POST /notes`, `GET/PATCH/DELETE /notes/:id`, `GET /notes/:id/history`, `GET /trackers/:id/notes` |
| Groups    | `GET/POST /groups`, `GET/PATCH/DELETE /groups/:id`, `GET/POST/DELETE /groups/:id/trackers[/:trackerId]`, `POST /groups/:id/reorder` |
| Stats     | `GET /trackers/:id/stats/{buckets,streak,target-progress}`                                 |
| Backup    | `GET /backup/{manifest,bundle,sqlite}`, `POST /backup/import`                              |
| Health    | `GET /health`                                                                              |

`GET /backup/bundle` streams a `.countroster.zip` (manifest + `all.json` + per-table
CSVs); `GET /backup/sqlite` streams the raw database file; `POST /backup/import`
accepts a bundle (`?confirmOverwrite=1` to replace non-empty data).

## License

`AGPL-3.0-only`, like the rest of CountRoster — see [`LICENSE`](../../LICENSE).
Note AGPL §13: if you run a **modified** server over a network for others, you
must offer them its source. Contributions are taken under the
[CLA](../../CLA.md); see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
