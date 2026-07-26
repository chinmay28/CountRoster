import { Suspense, lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useHiddenMode } from '../app/HiddenMode.tsx';
import { useAsync } from '../app/useAsync.ts';
import { CompositionSection } from '../components/CompositionSection.tsx';
import { EntryFieldsInput } from '../components/EntryFieldsInput.tsx';
import { FieldBreakdownSection } from '../components/FieldBreakdownSection.tsx';
import { EntryList } from '../components/EntryList.tsx';
import { MultiLogPanel } from '../components/MultiLogPanel.tsx';
import { NotesSection } from '../components/NotesSection.tsx';
import { PeriodTable } from '../components/PeriodTable.tsx';
import { DragHandle, SortableList } from '../components/SortableList.tsx';

// Charts pull in Observable Plot (~100KB gzip); load them on demand so the
// home screen and first paint stay light on mobile.
const StatsPanel = lazy(() =>
  import('../components/StatsPanel.tsx').then((m) => ({ default: m.StatsPanel })),
);
import { formatValue, formatNumber, KIND_LABELS } from '../lib/format.ts';
import {
  sumValues,
  sumInRange,
  resetPeriodRange,
  windowStats,
  snapshotStats,
  latestValue,
  RESET_PERIOD_LABEL,
} from '../lib/range.ts';
import { fromDatetimeLocalValue } from '../lib/format.ts';
import { readableInk } from '../lib/color.ts';
import { emptyAnswers, hasAnyAnswer, type FieldAnswers } from '../lib/fields.ts';
import {
  SECTION_LABELS,
  isSectionKey,
  resolveSectionOrder,
  serializeSectionOrder,
  type SectionKey,
} from '../lib/sections.ts';

/** Per-tracker detail: header, custom log, period table, notes. */
export function TrackerDetailPage() {
  const core = useCore();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { enabled: hiddenMode } = useHiddenMode();

  const { data, loading, error, reload } = useAsync(async () => {
    if (!id) return null;
    const tracker = await core.trackers.get(id);
    // A hidden tracker reached by direct URL while hidden mode is off behaves
    // exactly like a missing one — it doesn't exist as far as this session
    // can tell.
    if (!tracker || (tracker.is_hidden === 1 && !hiddenMode)) {
      return {
        tracker: null,
        entries: [],
        notes: [],
        fields: [],
        links: [],
        sourceNames: new Map(),
      };
    }
    const [entries, notes, fields] = await Promise.all([
      core.entries.forTracker(id),
      core.notes.forTracker(id),
      // A derived tracker's rows belong to its sources, so it has no fields.
      tracker.is_derived === 1 ? Promise.resolve([]) : core.fields.list(id),
    ]);
    // For a derived tracker, also resolve its source operands (which may be
    // archived) so the detail can show what it's computed from.
    let links: Awaited<ReturnType<typeof core.trackers.links>> = [];
    let sourceNames = new Map<string, string>();
    if (tracker.is_derived) {
      const [linkRows, all] = await Promise.all([
        core.trackers.links(id),
        core.trackers.list({ includeArchived: true, includeHidden: hiddenMode }),
      ]);
      links = linkRows;
      sourceNames = new Map(all.map((t) => [t.id, t.name]));
    }
    return { tracker, entries, notes, fields, links, sourceNames };
  }, [id, hiddenMode]);

  const [customValue, setCustomValue] = useState('');
  const [customWhen, setCustomWhen] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [customFields, setCustomFields] = useState<FieldAnswers>({});
  const [logging, setLogging] = useState(false);
  // Surfaces a rejected answer (an unanswered required field, say) instead of
  // failing silently.
  const [logError, setLogError] = useState<string | null>(null);
  // Which logging mode the user is in: one detailed entry, or a batch sheet.
  const [logTab, setLogTab] = useState<'single' | 'multi'>('single');
  // Which reading of the entries the user is on: totals per period, or the
  // raw timeline. Null until they pick — the default depends on the tracker,
  // which isn't loaded yet on the first render.
  const [entryTab, setEntryTab] = useState<'periods' | 'entries' | null>(null);
  // Whether the section-order editor is open.
  const [arranging, setArranging] = useState(false);
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

  const { tracker, entries, notes, fields, links, sourceNames } = data;
  const isDerived = tracker.is_derived === 1;
  const isSnapshot = tracker.is_snapshot === 1;
  const total = sumValues(entries);

  // Total for the current reset window (today / this week / …). Compared by
  // absolute instant so it's correct regardless of the offset entries were
  // logged in. `null` range means the tracker never resets (cumulative).
  const periodRange = resetPeriodRange(tracker.reset_period, tracker);
  const periodTotal = periodRange ? sumInRange(entries, periodRange) : total;

  // The headline: a snapshot tracker shows its most recent reading (levels
  // don't add up); otherwise the reset-window total or the all-time total.
  const headline = isSnapshot
    ? latestValue(entries)
    : tracker.reset_period === 'never'
      ? total
      : periodTotal;
  const headlineLabel = isSnapshot
    ? 'current value'
    : tracker.reset_period === 'never'
      ? 'all-time total'
      : RESET_PERIOD_LABEL[tracker.reset_period];

  // Breakdown beneath the headline: windowed totals (this week / month / year
  // / all-time, redundant ones collapsed — see `windowStats`), or the all-time
  // high and low readings for a snapshot stat.
  const breakdown = isSnapshot
    ? snapshotStats(entries)
    : windowStats(entries, tracker);

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

  // A tracker that resets is *about* its periods, so it opens on the table;
  // one that just accumulates opens on the timeline it always had.
  const activeEntryTab =
    entryTab ?? (tracker.reset_period === 'never' ? 'entries' : 'periods');

  // Which sections this particular tracker has: a derivation only exists for
  // a derived tracker, and only a directly-logged one can be logged to.
  const available: SectionKey[] = [
    'summary',
    ...(isDerived ? (['derivation', 'composition'] as const) : []),
    ...(fields.length > 0 ? (['fields'] as const) : []),
    'trends',
    ...(isDerived ? [] : (['log'] as const)),
    'entries',
    'notes',
  ];
  const order = resolveSectionOrder(tracker.section_order, available);

  async function customLog(e: React.FormEvent) {
    e.preventDefault();
    setLogging(true);
    setLogError(null);
    try {
      const occurredAt = customWhen ? fromDatetimeLocalValue(customWhen) : undefined;
      // Send the answers only when the form has any — an empty object would
      // read as "clear them all", which is meaningless on a new entry, and
      // omitting it lets a tracker with no fields log exactly as before.
      const entry = await core.entries.log(tracker!.id, {
        ...(customValue.trim() ? { value: Number(customValue) } : {}),
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
        ...(hasAnyAnswer(customFields) ? { fields: customFields } : {}),
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
      setCustomFields(emptyAnswers(fields));
      refresh();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
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

  /** Persist a new section order (null resets to the default). */
  async function saveOrder(next: SectionKey[] | null) {
    setActionError(null);
    try {
      await core.trackers.update(tracker!.id, {
        section_order: next && serializeSectionOrder(next, available),
      });
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  const sections: Record<SectionKey, React.ReactNode> = {
    summary: (
      <section key="summary" className="detail__summary card">
        <span className="detail__total" style={{ color: tracker.color }}>
          {formatValue(tracker, headline)}
        </span>
        <span className="muted">
          {headlineLabel} · {entries.length} entries
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
    ),

    derivation: (
      <section key="derivation" className="detail__derivation card">
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
    ),

    // Percentage breakdown per source (the component hides itself for
    // single-operand derivations). For a snapshot derivation it composes the
    // sources' levels instead of their sums. Entries arrive oldest-first;
    // their instants scope the period dropdown.
    composition: <CompositionSection key="composition" tracker={tracker} entries={entries} />,

    // What the tracker's total splits into, once it captures anything to
    // split it by.
    fields: (
      <FieldBreakdownSection
        key="fields"
        tracker={tracker}
        fields={fields}
        entries={entries}
        refreshKey={statsKey}
      />
    ),

    trends: (
      <Suspense key="trends" fallback={<p className="muted">Loading charts…</p>}>
        <StatsPanel tracker={tracker} refreshKey={statsKey} />
      </Suspense>
    ),

    log: (
      <section key="log" className="detail__log">
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
            {fields.length > 0 && (
              <EntryFieldsInput
                fields={fields}
                answers={customFields}
                onChange={setCustomFields}
                disabled={logging}
                accent={tracker.color}
              />
            )}
            <label className="field detail__custom-note">
              <span>Note (optional)</span>
              <textarea
                rows={2}
                placeholder="Describe this entry…"
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
              />
            </label>
            {logError && <p className="error">{logError}</p>}
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
    ),

    entries: (
      <section key="entries" className="detail__entries">
        {/* Two readings of the same data: totalled per reset period, or the
            raw timeline (the only place entries can be edited). */}
        <h2>
          {isDerived
            ? isSnapshot
              ? 'Level history'
              : 'Contributing entries'
            : 'Entries'}
        </h2>
        <div className="logtabs" role="tablist" aria-label="Entry view">
          <button
            type="button"
            role="tab"
            id="entrytab-periods"
            aria-selected={activeEntryTab === 'periods'}
            aria-controls="entrypanel-periods"
            className={`logtabs__tab${
              activeEntryTab === 'periods' ? ' logtabs__tab--active' : ''
            }`}
            onClick={() => setEntryTab('periods')}
          >
            By period
          </button>
          <button
            type="button"
            role="tab"
            id="entrytab-entries"
            aria-selected={activeEntryTab === 'entries'}
            aria-controls="entrypanel-entries"
            className={`logtabs__tab${
              activeEntryTab === 'entries' ? ' logtabs__tab--active' : ''
            }`}
            onClick={() => setEntryTab('entries')}
          >
            All entries
          </button>
        </div>

        {activeEntryTab === 'periods' ? (
          <div role="tabpanel" id="entrypanel-periods" aria-labelledby="entrytab-periods">
            <PeriodTable
              tracker={tracker}
              earliest={entries[0]?.occurred_at}
              refreshKey={statsKey}
            />
          </div>
        ) : (
          <div role="tabpanel" id="entrypanel-entries" aria-labelledby="entrytab-entries">
            <EntryList
              tracker={tracker}
              entries={entries}
              fields={fields}
              notesByEntry={notesByEntry}
              onChanged={refresh}
              readOnly={isDerived}
            />
          </div>
        )}
      </section>
    ),

    notes: (
      <NotesSection
        key="notes"
        trackerId={tracker.id}
        notes={standaloneNotes}
        onChanged={refresh}
      />
    ),
  };

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
            {isSnapshot
              ? ' · snapshot stat'
              : tracker.reset_period !== 'never'
                ? ` · resets ${tracker.reset_period}`
                : ''}
          </p>
          {tracker.description && <p>{tracker.description}</p>}
        </div>
        <div className="detail__header-actions">
          {!isDerived && (
            <Link
              to={`/trackers/${tracker.id}/quick`}
              className="btn"
              style={{ borderColor: tracker.color, color: tracker.color }}
              title="A full-screen logging page for this tracker — bookmark it for one-tap entries"
            >
              Quick log
            </Link>
          )}
          <button
            type="button"
            className={`btn${arranging ? ' btn--active' : ''}`}
            aria-pressed={arranging}
            onClick={() => setArranging((on) => !on)}
            title="Reorder the sections of this page"
          >
            Arrange
          </button>
          <Link to={`/trackers/${tracker.id}/edit`} className="btn">
            Edit
          </Link>
          <button className="btn btn--danger" onClick={archive}>
            Archive
          </button>
        </div>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      {arranging && (
        <section className="card arrange">
          <div className="arrange__head">
            <h2>Arrange sections</h2>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => saveOrder(null)}
              disabled={tracker.section_order == null}
            >
              Reset to default
            </button>
          </div>
          <p className="muted">Drag a section to move it up or down this page.</p>
          <SortableList
            className="arrange__list"
            itemClassName="arrange__item"
            ariaLabel="Page sections"
            items={order.map((key) => ({ id: key }))}
            onReorder={(ids) => saveOrder(ids.filter(isSectionKey))}
            renderItem={(item, handleProps) => (
              <>
                <DragHandle
                  handleProps={handleProps}
                  label={`Reorder ${SECTION_LABELS[item.id as SectionKey]}`}
                />
                <span>{SECTION_LABELS[item.id as SectionKey]}</span>
              </>
            )}
          />
        </section>
      )}

      {order.map((key) => sections[key])}
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
