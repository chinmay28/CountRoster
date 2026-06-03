import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import type { CountRosterCore } from '@countroster/core';

export const APP_VERSION = '0.1.0';

/** The optional capability the raw-SQLite download route needs. */
export interface SqliteFileSource {
  /** Absolute path to the on-disk SQLite file, or null if in-memory. */
  path: string;
}

export interface BuildAppOptions {
  /** If set, the API can serve a raw .sqlite download from this path. */
  fileSource?: SqliteFileSource;
}

/**
 * Build the Express API over a constructed core. Pure wiring — no I/O, no
 * listening — so tests can mount it against a memory-backed core.
 */
export function buildApp(
  core: CountRosterCore,
  opts: BuildAppOptions = {},
): Express {
  const app = express();
  const api = express.Router();
  api.use(express.json({ limit: '5mb' }));

  // ---- Trackers -----------------------------------------------------------
  api.get('/trackers', async (req, res) => {
    const includeArchived = req.query.includeArchived === '1';
    res.json(await core.trackers.list({ includeArchived }));
  });
  api.post('/trackers', async (req, res) => {
    res.status(201).json(await core.trackers.create(req.body));
  });
  api.post('/trackers/reorder', async (req, res) => {
    await core.trackers.reorder(req.body.orderedIds ?? []);
    res.status(204).end();
  });
  api.get('/trackers/:id', async (req, res) => {
    const t = await core.trackers.get(req.params.id);
    if (!t) return notFound(res, 'tracker');
    res.json(t);
  });
  api.patch('/trackers/:id', async (req, res) => {
    res.json(await core.trackers.update(req.params.id, req.body));
  });
  api.post('/trackers/:id/archive', async (req, res) => {
    await core.trackers.archive(req.params.id);
    res.status(204).end();
  });
  api.post('/trackers/:id/unarchive', async (req, res) => {
    await core.trackers.unarchive(req.params.id);
    res.status(204).end();
  });

  // ---- Entries ------------------------------------------------------------
  api.get('/trackers/:id/entries', async (req, res) => {
    res.json(await core.entries.forTracker(req.params.id, timeRange(req)));
  });
  api.post('/trackers/:id/entries', async (req, res) => {
    res.status(201).json(await core.entries.log(req.params.id, req.body));
  });
  api.get('/entries/:id', async (req, res) => {
    const e = await core.entries.get(req.params.id);
    if (!e) return notFound(res, 'entry');
    res.json(e);
  });
  api.patch('/entries/:id', async (req, res) => {
    res.json(await core.entries.update(req.params.id, req.body));
  });
  api.delete('/entries/:id', async (req, res) => {
    await core.entries.delete(req.params.id);
    res.status(204).end();
  });

  // ---- Notes --------------------------------------------------------------
  api.get('/trackers/:id/notes', async (req, res) => {
    res.json(await core.notes.forTracker(req.params.id, timeRange(req)));
  });
  api.post('/notes', async (req, res) => {
    res.status(201).json(await core.notes.create(req.body));
  });
  api.get('/notes/:id/history', async (req, res) => {
    res.json(await core.notes.history(req.params.id));
  });
  api.patch('/notes/:id', async (req, res) => {
    res.json(await core.notes.edit(req.params.id, req.body.body));
  });
  api.delete('/notes/:id', async (req, res) => {
    await core.notes.delete(req.params.id);
    res.status(204).end();
  });

  // ---- Groups -------------------------------------------------------------
  api.get('/groups', async (_req, res) => {
    res.json(await core.groups.list());
  });
  api.post('/groups', async (req, res) => {
    res.status(201).json(await core.groups.create(req.body));
  });
  api.get('/groups/:id', async (req, res) => {
    const g = await core.groups.get(req.params.id);
    if (!g) return notFound(res, 'group');
    res.json(g);
  });
  api.patch('/groups/:id', async (req, res) => {
    res.json(await core.groups.update(req.params.id, req.body));
  });
  api.delete('/groups/:id', async (req, res) => {
    await core.groups.delete(req.params.id);
    res.status(204).end();
  });
  api.get('/groups/:id/trackers', async (req, res) => {
    res.json(await core.groups.trackersIn(req.params.id));
  });
  api.post('/groups/:id/trackers', async (req, res) => {
    await core.groups.addTracker(req.params.id, req.body.tracker_id);
    res.status(204).end();
  });
  api.post('/groups/:id/reorder', async (req, res) => {
    await core.groups.reorderMembers(req.params.id, req.body.orderedTrackerIds ?? []);
    res.status(204).end();
  });
  api.delete('/groups/:id/trackers/:trackerId', async (req, res) => {
    await core.groups.removeTracker(req.params.id, req.params.trackerId);
    res.status(204).end();
  });

  // ---- Reminders ----------------------------------------------------------
  api.get('/trackers/:id/reminders', async (req, res) => {
    res.json(await core.reminders.forTracker(req.params.id));
  });
  api.post('/reminders', async (req, res) => {
    res.status(201).json(await core.reminders.create(req.body));
  });
  api.get('/reminders/:id', async (req, res) => {
    const r = await core.reminders.get(req.params.id);
    if (!r) return notFound(res, 'reminder');
    res.json(r);
  });
  api.patch('/reminders/:id', async (req, res) => {
    res.json(await core.reminders.update(req.params.id, req.body));
  });
  api.post('/reminders/:id/toggle', async (req, res) => {
    res.json(await core.reminders.toggleEnabled(req.params.id, Boolean(req.body.enabled)));
  });
  api.delete('/reminders/:id', async (req, res) => {
    await core.reminders.delete(req.params.id);
    res.status(204).end();
  });

  // ---- Stats --------------------------------------------------------------
  api.get('/trackers/:id/stats/buckets', async (req, res) => {
    const start = String(req.query.start ?? '');
    const end = String(req.query.end ?? '');
    const period = String(req.query.period ?? 'day') as 'day' | 'week' | 'month' | 'year';
    res.json(await core.stats.bucket(req.params.id, { start, end }, period));
  });
  api.get('/trackers/:id/stats/streak', async (req, res) => {
    res.json(await core.stats.streak(req.params.id));
  });
  api.get('/trackers/:id/stats/target-progress', async (req, res) => {
    const at = req.query.at ? String(req.query.at) : undefined;
    res.json(await core.stats.targetProgress(req.params.id, at));
  });

  // ---- Backup -------------------------------------------------------------
  api.get('/backup/manifest', async (_req, res) => {
    res.json(await core.backup.buildManifest({ app_version: APP_VERSION }));
  });
  api.get('/backup/bundle', async (_req, res) => {
    const bytes = await core.backup.exportBundle({ app_version: APP_VERSION });
    const stamp = new Date().toISOString().slice(0, 10);
    res
      .status(200)
      .type('application/zip')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="countroster-${stamp}.countroster.zip"`,
      );
    res.send(Buffer.from(bytes));
  });
  // Raw SQLite download streams the on-disk file directly (engine-specific,
  // so it lives at the server level rather than in the SQL-only core).
  api.get('/backup/sqlite', async (_req, res, next) => {
    if (!opts.fileSource || opts.fileSource.path === ':memory:') {
      return res.status(501).json({ error: 'Raw SQLite export unavailable for an in-memory database' });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.download(opts.fileSource.path, `countroster-${stamp}.sqlite`, (err) => {
      if (err) next(err);
    });
  });
  api.post(
    '/backup/import',
    express.raw({ type: '*/*', limit: '100mb' }),
    async (req, res) => {
      const confirmOverwrite = req.query.confirmOverwrite === '1';
      const bytes = new Uint8Array(req.body as Buffer);
      res.json(await core.backup.importBundle(bytes, { confirmOverwrite }));
    },
  );

  api.get('/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION });
  });

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}

function timeRange(req: Request): { start?: string; end?: string } {
  const range: { start?: string; end?: string } = {};
  if (req.query.start) range.start = String(req.query.start);
  if (req.query.end) range.end = String(req.query.end);
  return range;
}

function notFound(res: Response, what: string): void {
  res.status(404).json({ error: `${what} not found` });
}

/** Map domain/validation errors to HTTP status codes. */
function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const e = err as { name?: string; message?: string; issues?: unknown };
  if (e?.name === 'ZodError') {
    res.status(400).json({ error: 'Validation failed', issues: e.issues });
    return;
  }
  if (typeof e?.name === 'string' && e.name.endsWith('NotFoundError')) {
    res.status(404).json({ error: e.message });
    return;
  }
  console.error('[countroster] unhandled error:', err);
  res.status(500).json({ error: e?.message ?? 'Internal server error' });
}
