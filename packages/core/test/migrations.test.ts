import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../src/storage/memory.js';
import { createApp } from '../src/createApp.js';
import { fixedClock } from '../src/time.js';
import { LATEST_VERSION } from '../src/schema/migrations/index.js';

describe('migrations', () => {
  it('on a fresh DB, currentVersion is 0', async () => {
    const storage = MemoryAdapter.open();
    const app = createApp(storage, { clock: fixedClock('2026-01-01T00:00:00.000Z') });
    expect(await app.migrations.currentVersion()).toBe(0);
  });

  it('run() applies all pending migrations and updates schema_version', async () => {
    const storage = MemoryAdapter.open();
    const app = createApp(storage, { clock: fixedClock('2026-01-01T00:00:00.000Z') });

    const versionAfter = await app.migrations.run();
    expect(versionAfter).toBe(LATEST_VERSION);
    expect(await app.migrations.currentVersion()).toBe(LATEST_VERSION);
  });

  it('run() is idempotent', async () => {
    const storage = MemoryAdapter.open();
    const app = createApp(storage, { clock: fixedClock('2026-01-01T00:00:00.000Z') });

    await app.migrations.run();
    const second = await app.migrations.run();
    expect(second).toBe(LATEST_VERSION);
  });

  it('creates every expected table', async () => {
    const storage = MemoryAdapter.open();
    const app = createApp(storage, { clock: fixedClock('2026-01-01T00:00:00.000Z') });
    await app.migrations.run();

    const tables = await storage.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((t) => t.name);
    for (const expected of [
      'app_meta',
      'entries',
      'note_edits',
      'notes',
      'reminders',
      'tracker_group_memberships',
      'tracker_groups',
      'tracker_options',
      'trackers',
    ]) {
      expect(names).toContain(expected);
    }
  });
});
