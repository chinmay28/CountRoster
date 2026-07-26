import type {
  BucketPeriod,
  Entry,
  Note,
  Tracker,
  TrackerField,
} from '@countroster/core';
import { NoteHistory } from './NoteItem.tsx';
import { useEntryEditor } from './useEntryEditor.ts';
import { formatValue, formatNumber, formatWithin } from '../lib/format.ts';
import { sumValues, latestValue } from '../lib/range.ts';
import { entryChips } from '../lib/fields.ts';

interface EntryTableProps {
  tracker: Tracker;
  /** The entries in the window, oldest first (as the core returns them). */
  entries: Entry[];
  /** The tracker's custom fields, so a row can show its answers. */
  fields?: readonly TrackerField[];
  /** Notes linked to an entry, keyed by `entry_id`. */
  notesByEntry?: Map<string, Note[]>;
  onChanged: () => void;
  /** A derived tracker's entries are computed, so they can't be edited. */
  readOnly?: boolean;
  /** The window's name, lowercased for prose: "today", "this week". */
  windowLabel: string;
  /** The window's period, which scales how each row's time is written. */
  windowPeriod: BucketPeriod;
}

/**
 * Every entry in the tracker's current reset window, as a table — the same
 * shape as the per-period breakdown, one row down. Where that table asks
 * "how did each period go", this one asks "what makes up the period I'm in",
 * so the running total is the interesting column: each row shows where the
 * window stood once that entry landed, and the top row is the window's total.
 *
 * A snapshot tracker's readings are levels, so they neither accumulate nor
 * total: the column becomes the change from the reading before.
 */
export function EntryTable({
  tracker,
  entries,
  fields = [],
  notesByEntry,
  onChanged,
  readOnly = false,
  windowLabel,
  windowPeriod,
}: EntryTableProps) {
  const isSnapshot = tracker.is_snapshot === 1;

  if (entries.length === 0) {
    return <p className="muted">Nothing logged {windowLabel} yet.</p>;
  }

  // Walk oldest → newest to accumulate, then flip: the table reads newest
  // first, like the per-period one.
  let running = 0;
  const rows = entries
    .map((entry, i) => {
      running += entry.value;
      const previous = i > 0 ? entries[i - 1]! : null;
      return {
        entry,
        note: notesByEntry?.get(entry.id)?.[0] ?? null,
        chips: entryChips(entry, fields),
        // For a level, "so far" is the step from the previous reading.
        trail: isSnapshot ? (previous ? entry.value - previous.value : null) : running,
      };
    })
    .reverse();

  // A column of nothing but em dashes is noise, and on a phone it is noise
  // that pushes Edit/Delete off the edge — so the Note column only exists
  // when something in this window actually carries one.
  const showNotes = rows.some((r) => r.note !== null);
  // A tracker that captures custom answers shows them here too — this is the
  // tab the page opens on, so an answer logged a moment ago has to be visible
  // without hunting for the timeline.
  const showChips = rows.some((r) => r.chips.length > 0);

  const total = isSnapshot ? latestValue(entries) : sumValues(entries);
  const ratio =
    !isSnapshot && tracker.target != null && tracker.reset_period !== 'never'
      ? Math.round((total / tracker.target) * 100)
      : null;

  return (
    <div className="periods">
      <div className="periods__scroll">
        <table className="periods__table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col" className="periods__num">
                {isSnapshot ? 'Reading' : 'Value'}
              </th>
              {showChips && <th scope="col">Answers</th>}
              {showNotes && <th scope="col">Note</th>}
              <th scope="col" className="periods__num">
                {isSnapshot ? 'Change' : 'Running'}
              </th>
              {!readOnly && <th scope="col" className="periods__num" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, note, chips, trail }) => (
              <EntryTableRow
                key={entry.id}
                tracker={tracker}
                entry={entry}
                note={note}
                chips={chips}
                showChips={showChips}
                trail={trail}
                isSnapshot={isSnapshot}
                showNotes={showNotes}
                readOnly={readOnly}
                windowPeriod={windowPeriod}
                onChanged={onChanged}
              />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
              </th>
              <td className="periods__num">{formatValue(tracker, total)}</td>
              {showChips && <td />}
              {showNotes && <td />}
              <td className="periods__num">
                {ratio === null ? '' : `${ratio}%`}
              </td>
              {!readOnly && <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="muted periods__note">
        {isSnapshot
          ? `Levels don’t add up: the total is the latest reading ${windowLabel}.`
          : ratio === null
            ? `Everything logged ${windowLabel}.`
            : `${formatValue(tracker, total)} of the ${formatNumber(
                tracker.target!,
                tracker.unit,
              )} target ${windowLabel}.`}
      </p>
    </div>
  );
}

/** One entry row, which swaps for an edit form in place. */
function EntryTableRow({
  tracker,
  entry,
  note,
  chips,
  showChips,
  trail,
  isSnapshot,
  showNotes,
  readOnly,
  windowPeriod,
  onChanged,
}: {
  tracker: Tracker;
  entry: Entry;
  note: Note | null;
  /** This entry's custom-field answers, ready to render. */
  chips: { key: string; label: string; color: string | null }[];
  /** Whether the table is rendering an Answers column at all. */
  showChips: boolean;
  /** Running total, or the step from the previous reading; null if neither. */
  trail: number | null;
  isSnapshot: boolean;
  /** Whether the table is rendering a Note column at all. */
  showNotes: boolean;
  readOnly: boolean;
  windowPeriod: BucketPeriod;
  onChanged: () => void;
}) {
  const ed = useEntryEditor(tracker, entry, note, onChanged);
  const columns =
    2 + (showChips ? 1 : 0) + (showNotes ? 1 : 0) + 1 + (readOnly ? 0 : 1);

  if (ed.editing) {
    // The fields don't fit the columns, so the editor takes the whole row —
    // the same three inputs the timeline offers.
    return (
      <tr className="entry-row--editing">
        <td colSpan={columns}>
          <div className="entry__edit-fields">
            <input
              type="number"
              step="any"
              inputMode="decimal"
              aria-label="Value"
              value={ed.value}
              onChange={(e) => ed.setValue(e.target.value)}
            />
            <input
              type="datetime-local"
              aria-label="When"
              value={ed.when}
              onChange={(e) => ed.setWhen(e.target.value)}
            />
          </div>
          <textarea
            className="entry__note-input"
            rows={2}
            placeholder="Note (optional)…"
            aria-label="Note"
            value={ed.noteBody}
            onChange={(e) => ed.setNoteBody(e.target.value)}
          />
          <div className="entry__actions">
            {note && (
              <button
                className="btn btn--small"
                onClick={() => ed.setShowHistory((v) => !v)}
                aria-expanded={ed.showHistory}
              >
                History
              </button>
            )}
            <button className="btn btn--small" onClick={ed.cancel} disabled={ed.busy}>
              Cancel
            </button>
            <button
              className="btn btn--small btn--primary"
              onClick={ed.save}
              disabled={ed.busy}
            >
              Save
            </button>
          </div>
          {note && ed.showHistory && <NoteHistory noteId={note.id} />}
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <th scope="row">{formatWithin(entry.occurred_at, windowPeriod)}</th>
      <td className="periods__num" style={{ color: tracker.color }}>
        {formatValue(tracker, entry.value)}
      </td>
      {showChips && (
        <td className="periods__note-cell">
          {chips.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <ul className="entry__chips periods__chips">
              {chips.map((chip) => (
                <li
                  key={chip.key}
                  className="chip"
                  style={
                    chip.color
                      ? {
                          borderColor: chip.color,
                          background: `color-mix(in srgb, ${chip.color} 18%, transparent)`,
                        }
                      : undefined
                  }
                >
                  {chip.label}
                </li>
              ))}
            </ul>
          )}
        </td>
      )}
      {showNotes && (
        <td className="periods__note-cell">
          {note ? note.body : <span className="muted">—</span>}
        </td>
      )}
      <td className="periods__num">
        {trail === null ? (
          <span className="muted">—</span>
        ) : isSnapshot ? (
          <Step tracker={tracker} delta={trail} />
        ) : (
          formatValue(tracker, trail)
        )}
      </td>
      {!readOnly && (
        <td className="periods__num periods__actions">
          <button className="btn btn--small" onClick={ed.start}>
            Edit
          </button>
          <button
            className="btn btn--small btn--danger"
            onClick={ed.remove}
            disabled={ed.busy}
          >
            Delete
          </button>
        </td>
      )}
    </tr>
  );
}

/** A level's move since the previous reading, as an arrow and a magnitude. */
function Step({ tracker, delta }: { tracker: Tracker; delta: number }) {
  if (delta === 0) return <span className="muted">±0</span>;
  return (
    <span className={delta > 0 ? 'periods__up' : 'periods__down'}>
      {delta > 0 ? '▲' : '▼'} {formatValue(tracker, Math.abs(delta))}
    </span>
  );
}
