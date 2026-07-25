import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { QuickKeypadPanel } from '../components/QuickKeypadPanel.tsx';
import { QuickStepperPanel } from '../components/QuickStepperPanel.tsx';
import { QuickTapPanel } from '../components/QuickTapPanel.tsx';
import { formatValue } from '../lib/format.ts';
import { quickMode } from '../lib/quick.ts';
import { readableInk } from '../lib/color.ts';
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
    if (!tracker) return { tracker: null, entries: [] };
    return { tracker, entries: await core.entries.forTracker(id) };
  }, [id]);

  const [busy, setBusy] = useState(false);
  const [undoable, setUndoable] = useState<Undoable | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);

  const tracker = data?.tracker ?? null;

  // Make this page installable *as itself*.
  //
  // Both the theme color and — crucially — the manifest are swapped while the
  // screen is up. The app's own manifest declares `start_url: "/"`, and Safari
  // (16.4+) and Chrome install what the manifest says, not the page you were
  // on: an icon added from here would open the app's home screen. Pointing at
  // the tracker's own manifest makes the icon launch this screen, and carry
  // the tracker's name and color. `apple-mobile-web-app-title` covers older
  // iOS, which labels the icon from that meta instead.
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

    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) {
      const previous = link.getAttribute('href');
      link.setAttribute('href', `/trackers/${tracker.id}/app.webmanifest`);
      restore.push(() => {
        if (previous != null) link.setAttribute('href', previous);
      });
    }

    return () => restore.forEach((undoChange) => undoChange());
  }, [tracker]);

  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  function armUndo(next: Undoable) {
    window.clearTimeout(undoTimer.current);
    setUndoable(next);
    undoTimer.current = window.setTimeout(() => setUndoable(null), UNDO_MS);
  }

  async function log(value: number, note?: string) {
    if (!tracker) return;
    setBusy(true);
    setLogError(null);
    try {
      const entry = await core.entries.log(tracker.id, { value });
      // A note typed alongside the value describes this very entry, so link
      // it — and remember it, since undo has to take both back.
      const created = note
        ? await core.notes.create({ tracker_id: tracker.id, entry_id: entry.id, body: note })
        : null;
      armUndo({
        entryId: entry.id,
        noteId: created?.id ?? null,
        label: `Logged ${formatValue(tracker, value)}`,
      });
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

  if (loading) {
    return (
      <div className="quick quick--bare">
        <p className="quick__status">Loading…</p>
      </div>
    );
  }

  if (error || !tracker) {
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
  const mode = quickMode(tracker);
  // Painted screens carry the tracker's color edge to edge; the keypad and
  // stepper need a neutral ground for their controls to read against.
  const painted = mode === 'tap';

  const total = sumValues(entries);
  const periodRange = resetPeriodRange(tracker.reset_period, tracker.week_start);
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
      <header className="quick__bar">
        <Link to="/" className="quick__bar-link">
          ‹ Home
        </Link>
        <Link to={`/trackers/${tracker.id}`} className="quick__bar-link">
          Details ›
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
