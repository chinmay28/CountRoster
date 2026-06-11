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

  it('returns 404 for an unknown tracker', async () => {
    const res = await api.get('/api/trackers/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 400 on validation failure', async () => {
    const res = await api.post('/api/trackers', { name: '' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Validation/);
  });

  it('groups and reminders endpoints work', async () => {
    const tracker = await (await api.post('/api/trackers', { name: 'Meds' })).json();
    const group = await (await api.post('/api/groups', { name: 'Health' })).json();
    let r = await api.post(`/api/groups/${group.id}/trackers`, { tracker_id: tracker.id });
    expect(r.status).toBe(204);
    const members = await (await api.get(`/api/groups/${group.id}/trackers`)).json();
    expect(members.map((t: { id: string }) => t.id)).toEqual([tracker.id]);

    const reminder = await (
      await api.post('/api/reminders', { tracker_id: tracker.id, time_minute: 480 })
    ).json();
    expect(reminder.enabled).toBe(1);
    const toggled = await (
      await api.post(`/api/reminders/${reminder.id}/toggle`, { enabled: false })
    ).json();
    expect(toggled.enabled).toBe(0);
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
