/**
 * Time helpers.
 *
 * The domain layer never calls Date.now() directly — it goes through a Clock,
 * which tests can substitute. This makes time-dependent behavior deterministic
 * and lets us property-test boundary math without `vi.useFakeTimers()` everywhere.
 */

export interface Clock {
  /** Current instant as an ISO 8601 string with timezone offset. */
  nowISO(): string;
}

/** Default clock: real wall-clock time, formatted in the local timezone. */
export const systemClock: Clock = {
  nowISO(): string {
    return toLocalISO(new Date());
  },
};

/** A clock fixed at a specific instant — for tests. */
export function fixedClock(iso: string): Clock {
  return {
    nowISO: () => iso,
  };
}

/**
 * Format a Date as ISO 8601 with the local timezone offset, e.g.
 * "2026-05-25T14:32:00.123-07:00". JavaScript's built-in `toISOString()`
 * always emits UTC ("Z"), which loses the user's local context — we need
 * the offset so that period-bucketing later can respect "what day was this
 * in the user's local time".
 */
export function toLocalISO(d: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);

  const offsetMin = -d.getTimezoneOffset(); // JS returns minutes WEST of UTC
  const sign = offsetMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offM = pad(Math.abs(offsetMin) % 60);

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}${sign}${offH}:${offM}`;
}
