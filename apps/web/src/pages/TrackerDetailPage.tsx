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
import { sumValues } from '../lib/range.ts';
import { fromDatetimeLocalValue } from '../lib/format.ts';

/** Per-tracker detail: header, custom log, entry timeline, notes. */
export function TrackerDetailPage() {
  const core = useCore();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, reload } = useAsync(async () => {
    if (!id) return null;
    const tracker = await core.trackers.get(id);
    if (!tracker) return { tracker: null, entries: [] };
    const entries = await core.entries.forTracker(id);
    return { tracker, entries };
  }, [id]);

  const [customValue, setCustomValue] = useState('');
  const [customWhen, setCustomWhen] = useState('');
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

  const { tracker, entries } = data;
  const total = sumValues(entries);

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
      await core.entries.log(tracker!.id, {
        ...(customValue.trim() ? { value: Number(customValue) } : {}),
        ...(customWhen ? { occurred_at: fromDatetimeLocalValue(customWhen) } : {}),
      });
      setCustomValue('');
      setCustomWhen('');
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
        <span className="detail__total">{formatValue(tracker, total)}</span>
        <span className="muted">all-time total · {entries.length} entries</span>
      </section>

      <Suspense fallback={<p className="muted">Loading charts…</p>}>
        <StatsPanel tracker={tracker} refreshKey={statsKey} />
        <CalendarHeatmap tracker={tracker} refreshKey={statsKey} />
      </Suspense>

      <section className="detail__log">
        <h2>Log an entry</h2>
        <div className="detail__log-row">
          <button className="btn btn--primary" onClick={quickLog} disabled={logging}>
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
          <button type="submit" className="btn" disabled={logging}>
            Log custom
          </button>
        </form>
      </section>

      <section className="detail__entries">
        <h2>Entries</h2>
        <EntryList tracker={tracker} entries={entries} onChanged={refresh} />
      </section>

      <RemindersSection trackerId={tracker.id} />

      <NotesSection trackerId={tracker.id} />
    </article>
  );
}
