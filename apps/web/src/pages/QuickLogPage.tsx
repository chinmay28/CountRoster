import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { EntryFieldsInput } from '../components/EntryFieldsInput.tsx';
import { QuickKeypadPanel } from '../components/QuickKeypadPanel.tsx';
import { QuickStepperPanel } from '../components/QuickStepperPanel.tsx';
import { QuickTapPanel } from '../components/QuickTapPanel.tsx';
import { datetimeInputLabel, formatValue, toDatetimeLocalValue } from '../lib/format.ts';
import { quickMode } from '../lib/quick.ts';
import { readableInk } from '../lib/color.ts';
import { emptyAnswers, hasAnyAnswer, type FieldAnswers } from '../lib/fields.ts';
import {
  latestValue,
  resetPeriodRange,
  sumInRange,
  sumValues,
  RESET_PERIOD_LABEL,
} from '../lib/range.ts';

/** How long the undo bar stays up after an entry is logged. */
const UNDO_MS = 5_000;

/** What was just logged, and what undoing it has to remove. */
interface Undoable {
  entryId: string;
  noteId: string | null;
  label: string;
}

/**
 * The dedicated per-tracker logging screen — `/trackers/:id/quick`.
 *
 * It renders *outside* the app shell: no header, no tab bar, no footer. The
 * point is a URL you bookmark or add to the Home Screen, so that launching it
 * lands you on one tracker with its log control under your thumb and nothing
 * else competing for the tap. The control itself comes from the tracker's
 * kind (see `quickMode`).
 *
 * Nothing here confirms before writing: a tap logs, and a five-second undo
 * bar takes it back. That is what keeps the promise of one-tap entry.
 */
export function QuickLogPage() {
  const core = useCore();
  const { id } = useParams<{ id: string }>();

  const { data, loading, error, reload } = useAsync(async () => {
    if (!id) return null;
    // Hidden trackers are reachable here on purpose. Elsewhere they need
    // hidden mode unlocked, but this screen exists to be bookmarked by its
    // unguessable id — and that bookmark is the deliberate act the unlock
    // stands in for. There is no way to browse to a tracker from here.
    const tracker = await core.trackers.get(id);
    if (!tracker) return { tracker: null, entries: [], fields: [] };
    const [entries, fields] = await Promise.all([
      core.entries.forTracker(id),
      // A derived tracker has no entries of its own, so no fields either.
      tracker.is_derived === 1 ? Promise.resolve([]) : core.fields.list(id),
    ]);
    return { tracker, entries, fields };
  }, [id]);

  const [busy, setBusy] = useState(false);
  const [undoable, setUndoable] = useState<Undoable | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  // The custom-field answers the next tap will carry. They live on the page
  // rather than inside a control because they describe the entry whichever
  // control produced its value.
  const [answers, setAnswers] = useState<FieldAnswers>({});
  const undoTimer = useRef<number | undefined>(undefined);

  const tracker = data?.tracker ?? null;

  // Make this page installable *as itself* across client-side navigations.
  //
  // On a fresh load the *server* already served this document with the
  // tracker's identity (manifest choice, name, tint) — that's what Add to
  // Home Screen reads, and it must not depend on script. This effect only
  // keeps the head honest when the user navigates here without a document
  // load, and restores the app's own identity on the way out.
  useEffect(() => {
    if (!tracker) return;
    const restore: (() => void)[] = [];

    const setMeta = (name: string, value: string) => {
      const meta = document.querySelector(`meta[name="${name}"]`);
      if (!meta) return;
      const previous = meta.getAttribute('content');
      meta.setAttribute('content', value);
      restore.push(() => {
        if (previous != null) meta.setAttribute('content', previous);
      });
    };

    setMeta('theme-color', tracker.color);
    setMeta('apple-mobile-web-app-title', tracker.name);

    // On iOS the server serves this page without a manifest link at all (see
    // quickShell) — leave it that way; the legacy bookmark path is the point.
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) {
      const current = link.getAttribute('href');
      // Restore the *app's* manifest on unmount — never a tracker manifest,
      // which the server may have already put here on a fresh load. Parking
      // that would pin this tracker's identity onto every page the user
      // browses to next.
      const appManifest =
        current && !current.endsWith('/app.webmanifest') ? current : '/manifest.webmanifest';
      link.setAttribute('href', `/trackers/${tracker.id}/app.webmanifest`);
      restore.push(() => link.setAttribute('href', appManifest));
    }

    return () => restore.forEach((undoChange) => undoChange());
  }, [tracker]);

  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  function armUndo(next: Undoable) {
    window.clearTimeout(undoTimer.current);
    setUndoable(next);
    undoTimer.current = window.setTimeout(() => setUndoable(null), UNDO_MS);
  }

  async function log(value: number, note?: string, occurredAt?: string) {
    if (!tracker) return;
    setBusy(true);
    setLogError(null);
    try {
      const entry = await core.entries.log(tracker.id, {
        value,
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
        ...(hasAnyAnswer(answers) ? { fields: answers } : {}),
      });
      // A note typed alongside the value describes this very entry, so link
      // it — and remember it, since undo has to take both back. It carries
      // the same instant, so the journal reads in the right order too.
      const created = note
        ? await core.notes.create({
            tracker_id: tracker.id,
            entry_id: entry.id,
            body: note,
            ...(occurredAt ? { occurred_at: occurredAt } : {}),
          })
        : null;
      armUndo({
        entryId: entry.id,
        noteId: created?.id ?? null,
        // Name the time when it isn't now, so a backdate left set from the
        // previous entry can't file this one silently in the past.
        label: occurredAt
          ? `Logged ${formatValue(tracker, value)} · ${datetimeInputLabel(
              toDatetimeLocalValue(occurredAt),
            )}`
          : `Logged ${formatValue(tracker, value)}`,
      });
      // Clear the answers rather than carrying them into the next tap: a
      // sticky "wet diaper: yes" would quietly attach itself to every feed
      // that followed.
      setAnswers(emptyAnswers(data?.fields ?? []));
      reload();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!undoable) return;
    window.clearTimeout(undoTimer.current);
    const target = undoable;
    setUndoable(null);
    setBusy(true);
    setLogError(null);
    try {
      // The note first: deleting the entry would only orphan it (the foreign
      // key nulls `entry_id` rather than cascading).
      if (target.noteId) await core.notes.delete(target.noteId);
      await core.entries.delete(target.entryId);
      reload();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Only the *first* load takes over the screen. Every log refreshes the
  // totals, and swapping the control out for "Loading…" each time would both
  // flash the screen and unmount the panel — losing a note half-typed or a
  // backdated time set for the entry you're about to log next.
  if (loading && !data) {
    return (
      <div className="quick quick--bare">
        <p className="quick__status">Loading…</p>
      </div>
    );
  }

  if (!tracker) {
    return (
      <div className="quick quick--bare">
        <div className="quick__empty">
          <h1>Tracker not found</h1>
          <p className="quick__muted">
            {error ? error.message : 'It may have been deleted, or the link is wrong.'}
          </p>
          <Link to="/" className="btn">
            Open CountRoster
          </Link>
        </div>
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const fields = data?.fields ?? [];
  const mode = quickMode(tracker);
  // Painted screens carry the tracker's color edge to edge; the keypad and
  // stepper need a neutral ground for their controls to read against.
  const painted = mode === 'tap';

  const total = sumValues(entries);
  const periodRange = resetPeriodRange(tracker.reset_period, tracker);
  const headline =
    tracker.is_snapshot === 1
      ? latestValue(entries)
      : periodRange
        ? sumInRange(entries, periodRange)
        : total;
  const headlineLabel =
    tracker.is_snapshot === 1 ? 'current' : RESET_PERIOD_LABEL[tracker.reset_period];

  const panelProps = { tracker, entries, busy, onLog: log };

  return (
    <div
      className={`quick${painted ? ' quick--painted' : ''}`}
      style={{ '--quick-accent': tracker.color, '--quick-ink': readableInk(tracker.color) } as React.CSSProperties}
    >
      {/* Details sits left because it's this screen's parent — the back
          direction — leaving Home on the right. */}
      <header className="quick__bar">
        <Link to={`/trackers/${tracker.id}`} className="quick__bar-link">
          ‹ Details
        </Link>
        <Link to="/" className="quick__bar-link">
          Home ›
        </Link>
      </header>

      <div className="quick__headline">
        <h1 className="quick__name">{tracker.name}</h1>
        {/* The stepper's dial already *is* the current reading; repeating it
            up here would put the same number on screen three times. */}
        {mode !== 'stepper' && (
          <span className="quick__total" style={painted ? undefined : { color: tracker.color }}>
            {formatValue(tracker, headline)}
          </span>
        )}
        <span className="quick__muted">
          {mode === 'stepper'
            ? `${entries.length} reading${entries.length === 1 ? '' : 's'}`
            : headlineLabel}
          {tracker.target != null ? ` · target ${formatValue(tracker, tracker.target)}` : ''}
        </span>
        {tracker.target != null && tracker.is_snapshot === 0 && (
          <div className="quick__track">
            <span
              style={{ width: `${Math.max(0, Math.min(100, (headline / tracker.target) * 100))}%` }}
            />
          </div>
        )}
      </div>

      {logError && <p className="quick__error">{logError}</p>}

      {/* Above the control, so the details are answered on the way to the tap
          that commits them. */}
      {fields.length > 0 && mode !== 'readonly' && (
        <div className="quick__fields">
          <EntryFieldsInput
            fields={fields}
            answers={answers}
            onChange={setAnswers}
            disabled={busy}
            accent={tracker.color}
          />
        </div>
      )}

      {mode === 'readonly' ? (
        <div className="quick__control quick__readonly">
          <p className="quick__muted">
            This tracker is computed from others, so there is nothing to log here.
          </p>
          <Link to={`/trackers/${tracker.id}`} className="btn">
            Open details
          </Link>
        </div>
      ) : mode === 'keypad' ? (
        <QuickKeypadPanel {...panelProps} />
      ) : mode === 'stepper' ? (
        <QuickStepperPanel {...panelProps} />
      ) : (
        <QuickTapPanel {...panelProps} />
      )}

      <div
        className={`quick__toast${undoable ? ' quick__toast--up' : ''}`}
        role="status"
        aria-live="polite"
      >
        {undoable && (
          <>
            <span>{undoable.label}</span>
            <button type="button" onClick={undo} disabled={busy}>
              Undo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
