/**
 * Whole-database JSON dump. TODO: implement.
 *
 * Shape (planned):
 * {
 *   "manifest": { ... },
 *   "tables": {
 *     "trackers": [ { ...row }, ... ],
 *     "entries":  [ { ...row }, ... ],
 *     ...
 *   }
 * }
 */
export function dumpAllJSON(): string {
  throw new Error('dumpAllJSON: not yet implemented');
}
