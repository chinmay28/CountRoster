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

/** How many of the most recent entries the preset amounts are mined from. */
const PRESET_SAMPLE = 60;

/**
 * The amounts this tracker is actually logged with, most-used first — the
 * quick screen's preset chips. Mined from the tail of the entry history
 * (which arrives oldest-first) so the presets follow how the tracker is used
 * now, not how it was used a year ago.
 *
 * Ties break toward the more recently used value. `exclude` drops amounts
 * already offered elsewhere on the screen (the tracker's default value has
 * its own chip).
 */
export function topValues(
  entries: readonly Entry[],
  { limit = 3, exclude = [] }: { limit?: number; exclude?: readonly number[] } = {},
): number[] {
  const recent = entries.slice(-PRESET_SAMPLE);
  const excluded = new Set(exclude);
  // value → how often it occurs, and how far along the sample it last
  // appeared (higher = more recent).
  const seen = new Map<number, { count: number; lastAt: number }>();
  recent.forEach((entry, index) => {
    if (excluded.has(entry.value)) return;
    const prev = seen.get(entry.value);
    seen.set(entry.value, { count: (prev?.count ?? 0) + 1, lastAt: index });
  });
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
    .slice(0, limit)
    .map(([value]) => value);
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
