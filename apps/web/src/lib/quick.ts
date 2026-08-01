import type { Entry, Tracker } from '@countroster/core';

/**
 * Which control the dedicated quick-log screen builds itself around. One
 * route (`/trackers/:id/quick`) serves every tracker; the tracker's own shape
 * picks the control, so nothing has to be configured per tracker.
 */
export type QuickMode = 'tap' | 'keypad' | 'readonly';

/**
 * Pick the quick-log control for a tracker:
 *
 * - `readonly` — derived trackers compute their value and reject logging.
 * - `tap`      — counts and yes/no habits have one obvious value; the whole
 *                screen becomes the button.
 * - `keypad`   — every other value is typed: amounts that vary (money,
 *                durations, choice codes) and snapshot readings alike. A
 *                reading is a fresh measurement, not a nudge away from the
 *                last one, so it starts blank on the same keypad — one that
 *                never shifts under a thumb the way the OS keyboard does.
 */
export function quickMode(tracker: Tracker): QuickMode {
  if (tracker.is_derived === 1) return 'readonly';
  // A snapshot's kind may be `count`, but a level is still typed, not tapped.
  if (tracker.is_snapshot === 1) return 'keypad';
  if (tracker.kind === 'count' || tracker.kind === 'boolean') return 'tap';
  return 'keypad';
}

/**
 * What every quick-log control needs: the tracker, its history (oldest-first,
 * as the services return it), a way to record one entry, and whether a write
 * is already in flight.
 */
export interface QuickPanelProps {
  tracker: Tracker;
  entries: readonly Entry[];
  busy: boolean;
  /**
   * Record one entry: optionally with a note describing it, and optionally at
   * an instant other than now (ISO 8601 with a local offset) for backdating.
   */
  onLog: (value: number, note?: string, occurredAt?: string) => void;
}

/** How many decimal places a number carries when written out. */
function decimalPlaces(value: number): number {
  return (String(value).split('.')[1] ?? '').length;
}

/**
 * How far a new reading moves from the one before it, rounded to the
 * precision the two readings themselves carry. Without the rounding,
 * 179 − 179.2 shows as −0.19999999999999996.
 */
export function readingDelta(next: number, previous: number): number {
  const places = Math.min(Math.max(decimalPlaces(next), decimalPlaces(previous)), 10);
  const factor = 10 ** places;
  return Math.round((next - previous) * factor) / factor;
}
