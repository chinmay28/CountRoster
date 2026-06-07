import { Suspense, lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { EntryList } from '../components/EntryList.tsx';
import { NotesSection } from '../components/NotesSection.tsx';
import { RemindersSection } from '../components/RemindersSection.tsx';

// Charts pull in Observable Plot (~100KB gzip); load them on demand so the
// home screen and first paint stay light on mobile.
const StatsPanel = lazy(() =>
  import('../components/StatsPanel.tsx').then((m) => ({ default: m.StatsPanel })),
);
const CalendarHeatmap = lazy(() =>
  import('../components/CalendarHeatmap.tsx').then((m) => ({
    default: m.CalendarHeatmap,
  })),
);
import { formatValue, formatNumber, KIND_LABELS } from '../lib/format.ts';
import { sumValues, resetPeriodRange, RESET_PERIOD_LABEL } from '../lib/range.ts';
import { fromDatetimeLocalValue } from '../lib/format.ts';
import { readableInk } from '../lib/color.ts';

/** Per-tracker detail: header, custom log, entry timeline, notes. */
export function TrackerDetailPage() {
  const core = useCore();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, reload } = useAsync(async () => {
    if (!id) return null;
    const tracker = await core.trackers.get(id);
    if (!tracker) return { tracker: null, entries: [], notes: [] };
    const [entries, notes] = await Promise.all([
      core.entries.forTracker(id),
      core.notes.forTracker(id),
    ]);
    return { tracker, entries, notes };
  }, [id]);

  const [customValue, setCustomValue] = useState('');
  const [customWhen, setCustomWhen] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [logging, setLogging] = useState(false);
  // Bumped on any write so the stats panel re-fetches alongside the entry list.
  const [statsKey, setStatsKey] = useState(0);

  function refresh() {
    reload();
    setStatsKey((k) => k + 1);
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error.message}</p>;
  if (!data || !data.tracker) {
    return (
      <div className="empty">
        <h1>Tracker not found</h1>
        <Link to="/" className="btn">
          Back home
        </Link>
      </div>
    );
  }

  const { tracker, entries, notes } = data;
  const total = sumValues(entries);

  // Total for the current reset window (today / this week / …). Compared by
  // absolute instant so it's correct regardless of the offset entries were
  // logged in. `null` range means the tracker never resets (cumulative).
  const periodRange = resetPeriodRange(tracker.reset_period, tracker.week_start);
  const periodTotal = periodRange
    ? sumValues(
        entries.filter((e) => {
          const t = new Date(e.occurred_at).getTime();
          return (
            t >= new Date(periodRange.start).getTime() &&
            t < new Date(periodRange.end).getTime()
          );
        }),
      )
    : total;

  // Notes that describe a specific entry are shown inline with that entry;
  // the rest are general journal notes for the Notes section.
  const notesByEntry = new Map<string, typeof notes>();
  const standaloneNotes: typeof notes = [];
  for (const note of notes) {
    if (note.entry_id) {
      const list = notesByEntry.get(note.entry_id) ?? [];
      list.push(note);
      notesByEntry.set(note.entry_id, list);
    } else {
      standaloneNotes.push(note);
    }
  }

  async function quickLog() {
    setLogging(true);
    try {
      await core.entries.log(tracker!.id);
      refresh();
    } finally {
      setLogging(false);
    }
  }

  async function customLog(e: React.FormEvent) {
    e.preventDefault();
    setLogging(true);
    try {
      const occurredAt = customWhen ? fromDatetimeLocalValue(customWhen) : undefined;
      const entry = await core.entries.log(tracker!.id, {
        ...(customValue.trim() ? { value: Number(customValue) } : {}),
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
      });
      // A note typed alongside the value describes this very entry, so link it.
      if (customNote.trim()) {
        await core.notes.create({
          tracker_id: tracker!.id,
          entry_id: entry.id,
          body: customNote.trim(),
          ...(occurredAt ? { occurred_at: occurredAt } : {}),
        });
      }
      setCustomValue('');
      setCustomWhen('');
      setCustomNote('');
      refresh();
    } finally {
      setLogging(false);
    }
  }

  async function archive() {
    if (!confirm(`Archive "${tracker!.name}"? You can restore it later.`)) return;
    await core.trackers.archive(tracker!.id);
    navigate('/');
  }

  return (
    <article className="detail">
      <header className="detail__header" style={{ borderTopColor: tracker.color }}>
        <div>
          <h1 className="page-title">{tracker.name}</h1>
          <p className="muted">
            {KIND_LABELS[tracker.kind]}
            {tracker.unit ? ` · ${tracker.unit}` : ''}
            {tracker.target != null
              ? ` · target ${formatNumber(tracker.target, tracker.unit)}`
              : ''}
            {tracker.reset_period !== 'never'
              ? ` · resets ${tracker.reset_period}`
              : ''}
          </p>
          {tracker.description && <p>{tracker.description}</p>}
        </div>
        <div className="detail__header-actions">
          <Link to={`/trackers/${tracker.id}/edit`} className="btn">
            Edit
          </Link>
          <button className="btn btn--danger" onClick={archive}>
            Archive
          </button>
        </div>
      </header>

      <section className="detail__summary card">
        {tracker.reset_period === 'never' ? (
          <>
            <span className="detail__total" style={{ color: tracker.color }}>
              {formatValue(tracker, total)}
            </span>
            <span className="muted">all-time total · {entries.length} entries</span>
          </>
        ) : (
          <>
            <span className="detail__total" style={{ color: tracker.color }}>
              {formatValue(tracker, periodTotal)}
            </span>
            <span className="muted">
              {RESET_PERIOD_LABEL[tracker.reset_period]} ·{' '}
              {formatValue(tracker, total)} all-time · {entries.length} entries
            </span>
          </>
        )}
      </section>

      <Suspense fallback={<p className="muted">Loading charts…</p>}>
        <StatsPanel tracker={tracker} refreshKey={statsKey} />
        <CalendarHeatmap tracker={tracker} refreshKey={statsKey} />
      </Suspense>

      <section className="detail__log">
        <h2>Log an entry</h2>
        <div className="detail__log-row">
          <button
            className="btn btn--primary"
            style={{ background: tracker.color, color: readableInk(tracker.color) }}
            onClick={quickLog}
            disabled={logging}
          >
            Quick log (+{tracker.default_value})
          </button>
        </div>
        <form className="detail__custom" onSubmit={customLog}>
          <label className="field">
            <span>Value</span>
            <input
              type="number"
              step="any"
              placeholder={String(tracker.default_value)}
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
            />
          </label>
          <label className="field">
            <span>When (optional, for backdating)</span>
            <input
              type="datetime-local"
              value={customWhen}
              onChange={(e) => setCustomWhen(e.target.value)}
            />
          </label>
          <label className="field detail__custom-note">
            <span>Note (optional)</span>
            <textarea
              rows={2}
              placeholder="Describe this entry…"
              value={customNote}
              onChange={(e) => setCustomNote(e.target.value)}
            />
          </label>
          <button type="submit" className="btn" disabled={logging}>
            Log custom
          </button>
        </form>
      </section>

      <section className="detail__entries">
        <h2>Entries</h2>
        <EntryList
          tracker={tracker}
          entries={entries}
          notesByEntry={notesByEntry}
          onChanged={refresh}
        />
      </section>

      <RemindersSection trackerId={tracker.id} />

      <NotesSection
        trackerId={tracker.id}
        notes={standaloneNotes}
        onChanged={refresh}
      />
    </article>
  );
}
