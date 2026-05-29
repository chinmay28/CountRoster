import { createApp, type CountRosterCore } from '@countroster/core';
import { SQLiteWasmAdapter } from './adapter.ts';

export interface BootedApp {
  core: CountRosterCore;
  /** Whether the underlying DB persists across reloads (OPFS) or is in-memory. */
  persistent: boolean;
  /** Schema version after migrations ran. */
  schemaVersion: number;
}

let bootPromise: Promise<BootedApp> | null = null;

/**
 * Open the storage adapter, wire the core, and run migrations — exactly the
 * sequence DESIGN/CLAUDE.md prescribe: open adapter → createApp → migrations.run().
 *
 * Memoized so React StrictMode's double-invoke and repeat callers share one
 * connection.
 */
export function bootApp(): Promise<BootedApp> {
  bootPromise ??= (async () => {
    const storage = await SQLiteWasmAdapter.open();
    const core = createApp(storage);
    const schemaVersion = await core.migrations.run();
    return { core, persistent: storage.persistent, schemaVersion };
  })();
  return bootPromise;
}
