import type { Entry, Tracker } from '@countroster/core';

/**
 * Which control the dedicated quick-log screen builds itself around. One
 * route (`/trackers/:id/quick`) serves every tracker; the tracker's own shape
 * picks the control, so nothing has to be configured per tracker.
 */
export type QuickMode = 'tap' | 'keypad' | 'stepper' | 'readonly';

/**
 * Pick the quick-log control for a tracker:
 *
 * - `readonly` — derived trackers compute their value and reject logging.
 * - `stepper`  — snapshot stats record a level, so logging starts from the
 *                previous reading and nudges it rather than starting blank.
 * - `tap`      — counts and yes/no habits have one obvious value; the whole
 *                screen becomes the button.
 * - `keypad`   — amounts that vary (money, durations, choice codes) need a
 *                number, entered on a keypad that never shifts under a thumb.
 */
export function quickMode(tracker: Tracker): QuickMode {
  if (tracker.is_derived === 1) return 'readonly';
  if (tracker.is_snapshot === 1) return 'stepper';
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

/**
 * The step the snapshot stepper moves by. The tracker's default value is the
 * user's own statement of "one unit of this" (0.2 lb, 1 point), so honor it;
 * fall back to 1 when it carries no useful step.
 */
export function stepSize(tracker: Tracker): number {
  const step = Math.abs(tracker.default_value);
  return step > 0 ? step : 1;
}

/**
 * Round to the precision `step` itself carries. Without this, stepping 178.4
 * by 0.2 lands on 178.60000000000002 — and that is what gets stored.
 */
export function roundToStep(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  const factor = 10 ** Math.min(decimals, 10);
  return Math.round(value * factor) / factor;
}

/** Move `value` one step in `direction`, at the step's own precision. */
export function applyStep(value: number, step: number, direction: 1 | -1): number {
  return roundToStep(value + direction * step, step);
}
