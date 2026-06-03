import { useState } from 'react';
import type { Reminder } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const ALL_DAYS = 127; // bits 0..6 set

/** minutes-from-midnight → "HH:MM" for an <input type="time">. */
function minutesToTimeValue(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeValueToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** minutes-from-midnight → friendly "8:00 AM". */
function formatTime(min: number): string {
  const d = new Date();
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Human list of active days from a bitmask, e.g. "Every day" / "Mon–Fri". */
function describeDays(mask: number): string {
  if (mask === ALL_DAYS) return 'Every day';
  if (mask === 0) return 'No days';
  if (mask === 0b0111110) return 'Weekdays';
  if (mask === 0b1000001) return 'Weekends';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names.filter((_, i) => (mask & (1 << i)) !== 0).join(', ');
}

/** Per-tracker reminders: list, add, toggle, and delete. */
export function RemindersSection({ trackerId }: { trackerId: string }) {
  const core = useCore();
  const { data: reminders, loading, error, reload } = useAsync(
    () => core.reminders.forTracker(trackerId),
    [trackerId],
  );

  const [time, setTime] = useState('09:00');
  const [daysMask, setDaysMask] = useState(ALL_DAYS);
  const [busy, setBusy] = useState(false);

  function toggleDay(i: number) {
    setDaysMask((m) => m ^ (1 << i));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await core.reminders.create({
        tracker_id: trackerId,
        time_minute: timeValueToMinutes(time),
        days_mask: daysMask,
        enabled: 1,
      });
      setTime('09:00');
      setDaysMask(ALL_DAYS);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="reminders">
      <h2>Reminders</h2>
      <p className="muted reminders__note">
        Scheduled reminder times, shared across your devices. (Push delivery
        isn’t wired up yet — these are the schedule of record.)
      </p>

      <form className="reminders__add" onSubmit={add}>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Reminder time"
        />
        <div className="reminders__days" role="group" aria-label="Days">
          {DAY_LABELS.map((label, i) => (
            <button
              key={i}
              type="button"
              className={`day-toggle${(daysMask & (1 << i)) !== 0 ? ' day-toggle--on' : ''}`}
              aria-pressed={(daysMask & (1 << i)) !== 0}
              aria-label={`Day ${i}`}
              onClick={() => toggleDay(i)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          Add reminder
        </button>
      </form>

      {loading && <p className="muted">Loading reminders…</p>}
      {error && <p className="error">{error.message}</p>}
      {reminders && reminders.length === 0 && (
        <p className="muted">No reminders yet.</p>
      )}

      <ul className="reminders__list">
        {reminders?.map((r) => (
          <ReminderRow key={r.id} reminder={r} onChanged={reload} />
        ))}
      </ul>
    </section>
  );
}

function ReminderRow({
  reminder,
  onChanged,
}: {
  reminder: Reminder;
  onChanged: () => void;
}) {
  const core = useCore();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await core.reminders.toggleEnabled(reminder.id, reminder.enabled === 0);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await core.reminders.delete(reminder.id);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`reminder${reminder.enabled === 0 ? ' reminder--off' : ''}`}>
      <span className="reminder__time">{formatTime(reminder.time_minute)}</span>
      <span className="reminder__days muted">{describeDays(reminder.days_mask)}</span>
      <div className="reminder__actions">
        <label className="reminder__enabled">
          <input
            type="checkbox"
            checked={reminder.enabled === 1}
            onChange={toggle}
            disabled={busy}
          />
          <span>{reminder.enabled === 1 ? 'On' : 'Off'}</span>
        </label>
        <button
          className="btn btn--small btn--danger"
          onClick={remove}
          disabled={busy}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
