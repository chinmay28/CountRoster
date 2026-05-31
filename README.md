# CountRoster

A local-first "anything tracker" — habits, medications, symptoms, spending, moods,
anything you want to count or log. Inspired by [Tally](https://apps.apple.com/us/app/tally-the-anything-tracker/id1090990601),
rebuilt with:

- **Local-first storage.** Your data lives in SQLite on your device. No account, no server.
- **Cross-platform.** iOS, Android, and web from a single shared TypeScript core.
- **Real data export.** Backup files are documented open formats (SQLite + JSON + CSV).
- **Editable journal notes.** With an append-only edit log so history isn't lost.

## Layout

```
countroster/
├── DESIGN.md                 # full design & architecture document
├── packages/
│   └── core/                 # @countroster/core — shared TypeScript domain
│       ├── src/
│       └── test/
└── apps/
    └── web/                  # @countroster/web — Vite + React SPA (sqlite-wasm + OPFS)
        └── src/
```

Future packages (not yet scaffolded):

- `apps/mobile` — Expo (React Native) for iOS + Android

## Getting started

```bash
npm install
npm run build   # typechecks and emits dist/ (build core before running the web app)
npm run test    # runs every workspace's Vitest suite

# Web shell
npm run dev --workspace @countroster/web   # http://localhost:5173
```

To run the web shell on an iPhone via Xcode (Capacitor, free Apple ID — no paid
Developer account), and how updates / Developer-account upgrades keep your data,
see [apps/web/README.md](./apps/web/README.md#run-on-an-iphone-via-xcode-no-apple-developer-account).

## Documentation

- [DESIGN.md](./DESIGN.md) — architecture, schema, `@countroster/core` API, roadmap
- [DEPLOYMENT.md](./DEPLOYMENT.md) — iOS, Android, and web deployment instructions, costs, and gotchas
- [apps/web/README.md](./apps/web/README.md) — web shell specifics, including running on iPhone via Xcode and keeping data across updates
