import { createApp, type CountRosterCore } from '../src/createApp.js';
import { MemoryAdapter } from '../src/storage/memory.js';
import { fixedClock, type Clock } from '../src/time.js';
import type { Storage } from '../src/storage/adapter.js';

export interface TestApp {
  app: CountRosterCore;
  storage: Storage;
  /** Advance the test clock to a new ISO time. */
  setTime(iso: string): void;
}

/**
 * Spin up a fresh in-memory app with migrations applied and a fixed clock.
 * Each test gets its own DB.
 */
export async function makeTestApp(
  initialTime = '2026-05-25T12:00:00.000-07:00',
): Promise<TestApp> {
  const storage = MemoryAdapter.open();
  let currentTime = initialTime;
  const clock: Clock = {
    nowISO: () => currentTime,
  };
  const app = createApp(storage, { clock });
  await app.migrations.run();
  return {
    app,
    storage,
    setTime(iso: string) {
      currentTime = iso;
    },
  };
}

/** Re-export for convenience. */
export { fixedClock };
