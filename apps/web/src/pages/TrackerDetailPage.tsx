import { Suspense, lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { EntryList } from '../components/EntryList.tsx';
import { MultiLogPanel } from '../components/MultiLogPanel.tsx';
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
import {
  sumValues,
  sumInRange,
  resetPeriodRange,
  windowStats,
  RESET_PERIOD_LABEL,
} from '../lib/range.ts';
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
    if (!tracker) {
      return { tracker: null, entries: [], notes: [], links: [], sourceNames: new Map() };
    }
    const [entries, notes] = await Promise.all([
      core.entries.forTracker(id),
      core.notes.forTracker(id),
    ]);
    // For a derived tracker, also resolve its source operands (which may be
    // archived) so the detail can show what it's computed from.
    let links: Awaited<ReturnType<typeof core.trackers.links>> = [];
    let sourceNames = new Map<string, string>();
    if (tracker.is_derived) {
      const [linkRows, all] = await Promise.all([
        core.trackers.links(id),
        core.trackers.list({ includeArchived: true }),
      ]);
      links = linkRows;
      sourceNames = new Map(all.map((t) => [t.id, t.name]));
    }
    return { tracker, entries, notes, links, sourceNames };
  }, [id]);

  const [customValue, setCustomValue] = useState('');
  const [customWhen, setCustomWhen] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [logging, setLogging] = useState(false);
  // Which logging mode the user is in: one detailed entry, or a batch sheet.
  const [logTab, setLogTab] = useState<'single' | 'multi'>('single');
  // Surfaces failures from header actions like archive (e.g. a tracker still in
  // use by a derived tracker).
  const [actionError, setActionError] = useState<string | null>(null);
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

  const { tracker, entries, notes, links, sourceNames } = data;
  const isDerived = tracker.is_derived === 1;
  const total = sumValues(entries);

  // Total for the current reset window (today / this week / …). Compared by
  // absolute instant so it's correct regardless of the offset entries were
  // logged in. `null` range means the tracker never resets (cumulative).
  const periodRange = resetPeriodRange(tracker.reset_period, tracker.week_start);
  const periodTotal = periodRange ? sumInRange(entries, periodRange) : total;

  // Breakdown across the standard windows (this week / month / year / all-time),
  // shown beneath the headline regardless of the reset period. Redundant
  // windows are collapsed — see `windowStats`.
  const breakdown = windowStats(entries, tracker.week_start);

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
    if (!confirm(`Archive "${tracker!.name}"? You can restore it later from the Data page.`)) return;
    setActionError(null);
    try {
      await core.trackers.archive(tracker!.id);
      navigate('/');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <article className="detail">
      <header className="detail__header" style={{ borderTopColor: tracker.color }}>
        <div>
          <h1 className="page-title">{tracker.name}</h1>
          <p className="muted">
            {isDerived ? 'Derived' : KIND_LABELS[tracker.kind]}
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

      {actionError && <p className="error">{actionError}</p>}

      <section className="detail__summary card">
        <span className="detail__total" style={{ color: tracker.color }}>
          {formatValue(tracker, tracker.reset_period === 'never' ? total : periodTotal)}
        </span>
        <span className="muted">
          {tracker.reset_period === 'never'
            ? 'all-time total'
            : RESET_PERIOD_LABEL[tracker.reset_period]}{' '}
          · {entries.length} entries
        </span>
        <dl className="detail__stats">
          {breakdown.map((stat) => (
            <div key={stat.key} className="detail__stat">
              <dt className="muted">{stat.label}</dt>
              <dd style={{ color: tracker.color }}>{formatValue(tracker, stat.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {isDerived && (
        <section className="detail__derivation card">
          <h2>Derived from</h2>
          {links.length === 0 ? (
            <p className="muted">
              No sources linked. Add sources from{' '}
              <Link to={`/trackers/${tracker.id}/edit`}>Edit</Link> to compute a value.
            </p>
          ) : (
            <ul className="derivation-list">
              {links.map((link) => (
                <li key={link.id} className="derivation-item">
                  <span className="derivation-item__op">{formatCoefficient(link.coefficient)}</span>
                  <Link to={`/trackers/${link.source_id}`}>
                    {sourceNames.get(link.source_id) ?? 'Unknown tracker'}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Suspense fallback={<p className="muted">Loading charts…</p>}>
        <StatsPanel tracker={tracker} refreshKey={statsKey} />
        <CalendarHeatmap tracker={tracker} refreshKey={statsKey} />
      </Suspense>

      {!isDerived && (
        <section className="detail__log">
          {/* One detailed entry (value/when/note) or a rapid batch sheet. */}
          <div className="logtabs" role="tablist" aria-label="Log entries">
            <button
              type="button"
              role="tab"
              id="logtab-single"
              aria-selected={logTab === 'single'}
              aria-controls="logpanel-single"
              className={`logtabs__tab${logTab === 'single' ? ' logtabs__tab--active' : ''}`}
              onClick={() => setLogTab('single')}
            >
              Log an entry
            </button>
            <button
              type="button"
              role="tab"
              id="logtab-multi"
              aria-selected={logTab === 'multi'}
              aria-controls="logpanel-multi"
              className={`logtabs__tab${logTab === 'multi' ? ' logtabs__tab--active' : ''}`}
              onClick={() => setLogTab('multi')}
            >
              Log multiple
            </button>
          </div>

          {logTab === 'multi' ? (
            <div role="tabpanel" id="logpanel-multi" aria-labelledby="logtab-multi">
              <MultiLogPanel tracker={tracker} onLogged={refresh} />
            </div>
          ) : (
          <form
            className="detail__custom"
            onSubmit={customLog}
            role="tabpanel"
            id="logpanel-single"
            aria-labelledby="logtab-single"
          >
            <label className="field">
              <span>Value</span>
              <input
                type="number"
                step="any"
                inputMode="decimal"
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
            <button
              type="submit"
              className="btn btn--primary"
              style={{ background: tracker.color, color: readableInk(tracker.color) }}
              disabled={logging}
            >
              Log entry
            </button>
          </form>
          )}
        </section>
      )}

      <section className="detail__entries">
        <h2>{isDerived ? 'Contributing entries' : 'Entries'}</h2>
        <EntryList
          tracker={tracker}
          entries={entries}
          notesByEntry={notesByEntry}
          onChanged={refresh}
          readOnly={isDerived}
        />
      </section>

      {!isDerived && <RemindersSection trackerId={tracker.id} />}

      <NotesSection
        trackerId={tracker.id}
        notes={standaloneNotes}
        onChanged={refresh}
      />
    </article>
  );
}

/** Render a link's coefficient as an operator: +1 → "+", −1 → "−", 2 → "× 2". */
function formatCoefficient(coefficient: number): string {
  if (coefficient === 1) return '+';
  if (coefficient === -1) return '−';
  if (coefficient < 0) return `− ${Math.abs(coefficient)} ×`;
  return `+ ${coefficient} ×`;
}
