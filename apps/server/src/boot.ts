import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp, type CountRosterCore } from '@countroster/core';
import { NodeSqliteAdapter } from './db/adapter.js';

export interface BootedServer {
  core: CountRosterCore;
  adapter: NodeSqliteAdapter;
  schemaVersion: number;
}

/**
 * Open the SQLite file adapter, wire the core, and run migrations — the
 * sequence DESIGN/CLAUDE.md prescribe: open adapter → createApp → migrations.run().
 */
export async function boot(dbPath: string): Promise<BootedServer> {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const adapter = NodeSqliteAdapter.open(dbPath);
  const core = createApp(adapter);
  const schemaVersion = await core.migrations.run();
  return { core, adapter, schemaVersion };
}
