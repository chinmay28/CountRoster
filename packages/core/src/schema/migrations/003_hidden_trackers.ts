/**
 * Migration 003 — hidden trackers.
 *
 * A *hidden* tracker is excluded from `TrackerService.list()` unless the
 * caller explicitly opts in with `includeHidden` — clients only opt in while
 * the user has unlocked "hidden mode" in the UI. Hiding is orthogonal to
 * archiving: an archived tracker is off the roster but discoverable; a hidden
 * one simply doesn't exist as far as a non-opted-in caller can tell.
 *
 * Derivations may not mix hidden and visible trackers (a visible derived
 * tracker would leak a hidden source's data, and a hidden derivation over
 * visible sources would drift the moment those sources change visibility).
 * That invariant is enforced in the tracker service, not the schema.
 */
export const M003_HIDDEN_TRACKERS = {
  version: 3,
  name: '003_hidden_trackers',
  up: /* sql */ `
    ALTER TABLE trackers
      ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0
      CHECK (is_hidden IN (0, 1));
  `,
} as const;
