import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { boot } from '../src/boot.js';
import { buildApp } from '../src/app.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const { core, adapter } = await boot(':memory:');
  const app = buildApp(core, { fileSource: { path: adapter.path } });
  await new Promise<void>((res) => {
    server = app.listen(0, () => res());
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

const api = {
  get: (p: string) => fetch(base + p),
  post: (p: string, body?: unknown) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  patch: (p: string, body: unknown) =>
    fetch(base + p, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  put: (p: string, body: unknown) =>
    fetch(base + p, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  del: (p: string) => fetch(base + p, { method: 'DELETE' }),
};

describe('CountRoster API', () => {
  it('health check responds', async () => {
    const res = await api.get('/api/health');
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('full tracker → entry → note lifecycle', async () => {
    // Create a tracker.
    const created = await api.post('/api/trackers', { name: 'Coffee', target: 3 });
    expect(created.status).toBe(201);
    const tracker = await created.json();
    expect(tracker.name).toBe('Coffee');

    // It shows up in the list.
    const list = await (await api.get('/api/trackers')).json();
    expect(list.map((t: { id: string }) => t.id)).toContain(tracker.id);

    // Log two entries.
    await api.post(`/api/trackers/${tracker.id}/entries`, { value: 1 });
    await api.post(`/api/trackers/${tracker.id}/entries`, { value: 2 });
    const entries = await (await api.get(`/api/trackers/${tracker.id}/entries`)).json();
    expect(entries).toHaveLength(2);

    // Target progress reflects the logged values.
    const prog = await (
      await api.get(`/api/trackers/${tracker.id}/stats/target-progress`)
    ).json();
    expect(prog.current).toBe(3);

    // Add and edit a note; history captures the prior body.
    const note = await (
      await api.post('/api/notes', { tracker_id: tracker.id, body: 'first' })
    ).json();
    await api.patch(`/api/notes/${note.id}`, { body: 'second' });
    const history = await (await api.get(`/api/notes/${note.id}/history`)).json();
    expect(history[0].prev_body).toBe('first');
  });

  it('archives, restores, then permanently deletes a tracker', async () => {
    const tracker = await (await api.post('/api/trackers', { name: 'Temp' })).json();

    // Archive hides it from the default list but keeps it with includeArchived.
    expect((await api.post(`/api/trackers/${tracker.id}/archive`)).status).toBe(204);
    const active = await (await api.get('/api/trackers')).json();
    expect(active.map((t: { id: string }) => t.id)).not.toContain(tracker.id);
    const archived = await (await api.get('/api/trackers?includeArchived=1')).json();
    expect(archived.map((t: { id: string }) => t.id)).toContain(tracker.id);

    // Restore brings it back to the active list.
    expect((await api.post(`/api/trackers/${tracker.id}/unarchive`)).status).toBe(204);
    const restored = await (await api.get('/api/trackers')).json();
    expect(restored.map((t: { id: string }) => t.id)).toContain(tracker.id);

    // Delete removes it for good.
    expect((await api.del(`/api/trackers/${tracker.id}`)).status).toBe(204);
    expect((await api.get(`/api/trackers/${tracker.id}`)).status).toBe(404);
    const gone = await (await api.get('/api/trackers?includeArchived=1')).json();
    expect(gone.map((t: { id: string }) => t.id)).not.toContain(tracker.id);
  });

  it('hides hidden trackers from the list unless includeHidden=1', async () => {
    const tracker = await (
      await api.post('/api/trackers', { name: 'Covert', is_hidden: 1 })
    ).json();
    expect(tracker.is_hidden).toBe(1);

    const def = await (await api.get('/api/trackers')).json();
    expect(def.map((t: { id: string }) => t.id)).not.toContain(tracker.id);

    const withHidden = await (await api.get('/api/trackers?includeHidden=1')).json();
    expect(withHidden.map((t: { id: string }) => t.id)).toContain(tracker.id);

    // Mixing visibilities in a derivation is rejected.
    const visible = await (await api.post('/api/trackers', { name: 'Overt' })).json();
    const mixed = await api.post('/api/trackers', {
      name: 'Mixed',
      is_hidden: 1,
      links: [{ source_id: visible.id, coefficient: 1 }],
    });
    expect(mixed.status).toBe(400);
  });

  it('batch-logs entries atomically across trackers', async () => {
    const a = await (await api.post('/api/trackers', { name: 'Batch A' })).json();
    const b = await (await api.post('/api/trackers', { name: 'Batch B', default_value: 4 })).json();

    const res = await api.post('/api/entries/batch', [
      { tracker_id: a.id, value: 2, occurred_at: '2026-05-24T12:00:00.000-07:00' },
      { tracker_id: b.id }, // uses b's default_value
    ]);
    expect(res.status).toBe(201);
    const logged = await res.json();
    expect(logged.map((e: { value: number }) => e.value)).toEqual([2, 4]);

    // A bad item rolls back the whole batch.
    const bad = await api.post('/api/entries/batch', [
      { tracker_id: a.id, value: 9 },
      { tracker_id: 'does-not-exist' },
    ]);
    expect(bad.status).toBe(404);
    const entries = await (await api.get(`/api/trackers/${a.id}/entries`)).json();
    expect(entries).toHaveLength(1);
  });

  it('returns 404 for an unknown tracker', async () => {
    const res = await api.get('/api/trackers/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure', async () => {
    const res = await api.post('/api/trackers', { name: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Validation/);
  });

  it('groups endpoints work', async () => {
    const tracker = await (await api.post('/api/trackers', { name: 'Meds' })).json();
    const group = await (await api.post('/api/groups', { name: 'Health' })).json();
    const r = await api.post(`/api/groups/${group.id}/trackers`, { tracker_id: tracker.id });
    expect(r.status).toBe(204);
    const members = await (await api.get(`/api/groups/${group.id}/trackers`)).json();
    expect(members.map((t: { id: string }) => t.id)).toEqual([tracker.id]);
  });

  it('creates a derived tracker that computes its sources, and rejects logging', async () => {
    const revenue = await (await api.post('/api/trackers', { name: 'Rev', kind: 'number' })).json();
    const expenses = await (await api.post('/api/trackers', { name: 'Exp', kind: 'number' })).json();
    await api.post(`/api/trackers/${revenue.id}/entries`, { value: 100 });
    await api.post(`/api/trackers/${expenses.id}/entries`, { value: 30 });

    const profit = await (
      await api.post('/api/trackers', {
        name: 'Profit',
        kind: 'number',
        links: [
          { source_id: revenue.id, coefficient: 1 },
          { source_id: expenses.id, coefficient: -1 },
        ],
      })
    ).json();
    expect(profit.is_derived).toBe(1);

    // Links are readable back.
    const links = await (await api.get(`/api/trackers/${profit.id}/links`)).json();
    expect(links).toHaveLength(2);

    // Its effective entries are the weighted combination of the sources.
    const entries = await (await api.get(`/api/trackers/${profit.id}/entries`)).json();
    const total = entries.reduce((s: number, e: { value: number }) => s + e.value, 0);
    expect(total).toBe(70);

    // The composition endpoint splits that total per source.
    const slices = await (
      await api.get(`/api/trackers/${profit.id}/stats/composition`)
    ).json();
    expect(
      slices.map((s: { name: string; total: number }) => [s.name, s.total]),
    ).toEqual([
      ['Rev', 100],
      ['Exp', -30],
    ]);

    // …and honors start/end query params (a window before any entry is all zeros).
    const scoped = await (
      await api.get(
        `/api/trackers/${profit.id}/stats/composition?end=2000-01-01T00:00:00.000Z`,
      )
    ).json();
    expect(scoped.map((s: { total: number }) => s.total)).toEqual([0, 0]);

    // Logging directly on a derived tracker is a 400.
    const logged = await api.post(`/api/trackers/${profit.id}/entries`, { value: 5 });
    expect(logged.status).toBe(400);

    // A self-referential / invalid derivation is a 400.
    const bad = await api.put(`/api/trackers/${profit.id}/links`, {
      links: [{ source_id: profit.id, coefficient: 1 }],
    });
    expect(bad.status).toBe(400);

    // A source in use can't be archived or deleted: 409 naming the dependent.
    const archived = await api.post(`/api/trackers/${revenue.id}/archive`);
    expect(archived.status).toBe(409);
    expect((await archived.json()).error).toMatch(/Profit/);
    const deleted = await api.del(`/api/trackers/${revenue.id}`);
    expect(deleted.status).toBe(409);

    // Once the derived tracker is gone, the source frees up.
    expect((await api.del(`/api/trackers/${profit.id}`)).status).toBe(204);
    expect((await api.del(`/api/trackers/${revenue.id}`)).status).toBe(204);
  });

  it('rejects invalid stats/buckets query params with a 400', async () => {
    const created = await api.post('/api/trackers', { name: 'Validated' });
    const tracker = await created.json();

    const badPeriod = await api.get(
      `/api/trackers/${tracker.id}/stats/buckets?start=2026-01-01T00:00:00.000Z&end=2026-02-01T00:00:00.000Z&period=fortnight`,
    );
    expect(badPeriod.status).toBe(400);

    const badDates = await api.get(
      `/api/trackers/${tracker.id}/stats/buckets?start=nonsense&end=alsononsense&period=day`,
    );
    expect(badDates.status).toBe(400);

    expect((await api.del(`/api/trackers/${tracker.id}`)).status).toBe(204);
  });

  it('tolerates reorder posts with no request body', async () => {
    // No content-type header, no body: express.json leaves req.body undefined.
    const res = await fetch(`${base}/api/trackers/reorder`, { method: 'POST' });
    expect(res.status).toBe(204);
  });

  it('exports a backup bundle and reports a manifest', async () => {
    const manifest = await (await api.get('/api/backup/manifest')).json();
    expect(manifest.checksums.tables).toMatch(/^sha256:/);

    const res = await api.get('/api/backup/bundle');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    const buf = new Uint8Array(await res.arrayBuffer());
    // ZIP local file header magic "PK\x03\x04".
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
