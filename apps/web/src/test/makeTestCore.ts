import {
  createApp,
  fixedClock,
  toLocalISO,
  type CountRosterCore,
  type Tracker,
} from '@countroster/core';
import { MemoryAdapter } from '@countroster/core/testing';

export interface TestCore {
  core: CountRosterCore;
  setTime(iso: string): void;
  /**
   * Create a tracker from a partial spec. `trackerInputSchema` defaults fill
   * the rest at runtime, but its inferred *output* type marks those fields
   * required — so this helper takes a loose shape and lets Zod do its job,
   * keeping test call sites terse.
   */
  createTracker(spec: { name: string } & Record<string, unknown>): Promise<Tracker>;
}

/**
 * A core wired to an in-memory (node:sqlite) DB with migrations applied and a
 * mutable clock — mirrors core's own `makeTestApp`, but exposed to the web
 * package so component tests can drive the same services the UI uses.
 *
 * Defaults to the real "now" (not a fixed past instant) because UI code like
 * `todayRange()` filters against the host wall clock; pinning the core to a
 * past day would put freshly-logged entries outside "today". Pass an explicit
 * `initialTime` (or call `setTime`) when a test needs determinism.
 *
 * The browser sqlite-wasm adapter can't run under jsdom; MemoryAdapter speaks
 * the identical Storage contract, so testing against it exercises the real
 * data flow.
 */
export async function makeTestCore(
  initialTime: string = toLocalISO(new Date()),
): Promise<TestCore> {
  const storage = MemoryAdapter.open();
  let now = initialTime;
  const core = createApp(storage, { clock: { nowISO: () => now } });
  await core.migrations.run();
  return {
    core,
    setTime(iso) {
      now = iso;
    },
    createTracker(spec) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return core.trackers.create(spec as any);
    },
  };
}

export { fixedClock };
