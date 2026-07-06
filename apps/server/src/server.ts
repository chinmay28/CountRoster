import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import { boot } from './boot.js';
import { buildApp } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_ENV = process.env.COUNTROSTER_DB ?? './data/countroster.sqlite';
// ':memory:' is a SQLite sentinel, not a path — don't resolve it to a file.
const DB_PATH = DB_ENV === ':memory:' ? ':memory:' : resolve(DB_ENV);

// Where the built web client lives. Defaults to apps/web/dist relative to the
// compiled server (apps/server/dist/server.js → ../../web/dist).
const WEB_DIST = resolve(
  process.env.WEB_DIST ?? join(__dirname, '..', '..', 'web', 'dist'),
);

async function main(): Promise<void> {
  const { core, adapter, schemaVersion } = await boot(DB_PATH);
  const app = buildApp(core, {
    fileSource: {
      path: adapter.path,
      checkpoint: () => adapter.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    },
  });

  // In production, serve the built PWA from the same origin as the API so the
  // mobile browser shell behaves like an installed app with no CORS hops.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    // SPA fallback: any non-API GET returns index.html so client-side routing
    // (deep links like /trackers/:id) works on refresh.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(join(WEB_DIST, 'index.html'));
    });
    console.log(`[countroster] serving web client from ${WEB_DIST}`);
  } else {
    console.log(
      `[countroster] no web build at ${WEB_DIST} — API only ` +
        '(run the web dev server separately).',
    );
  }

  app.listen(PORT, HOST, () => {
    console.log(
      `[countroster] API listening on http://${HOST}:${PORT} ` +
        `(db: ${DB_PATH}, schema v${schemaVersion})`,
    );
  });
}

main().catch((err) => {
  console.error('[countroster] failed to start:', err);
  process.exit(1);
});
