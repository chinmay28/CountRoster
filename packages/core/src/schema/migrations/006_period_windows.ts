/**
 * Migration 006 — custom period windows.
 *
 * A tracker's periods need not line up with the calendar. `day_start_minute`
 * (shipped in 001) already declares when a "day" begins — 420 for a day that
 * runs 7:00 AM → 6:59 AM — and `week_start` picks the weekday a week opens on.
 * These two columns complete the set:
 *
 * - `month_start_day` — the day-of-month a monthly window opens on, so a
 *   billing-style month can run the 8th → the 7th of the next month. Capped at
 *   28 so every month has the day (no February special case).
 * - `year_start_month` — the month a yearly window opens on, for fiscal years
 *   (4 = a year running April → March). It opens on `month_start_day` of that
 *   month, so the two compose.
 *
 * Defaults reproduce plain calendar bucketing, which is what every existing
 * row gets.
 */
export const M006_PERIOD_WINDOWS = {
  version: 6,
  name: '006_period_windows',
  up: /* sql */ `
    ALTER TABLE trackers
      ADD COLUMN month_start_day INTEGER NOT NULL DEFAULT 1
      CHECK (month_start_day BETWEEN 1 AND 28);

    ALTER TABLE trackers
      ADD COLUMN year_start_month INTEGER NOT NULL DEFAULT 1
      CHECK (year_start_month BETWEEN 1 AND 12);
  `,
} as const;
