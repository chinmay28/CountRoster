import type {
  BucketPeriod,
  Entry,
  Note,
  Tracker,
  TrackerField,
} from '@countroster/core';
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
  /**
   * A derived tracker's entries are computed from its sources, so they can't
   * be edited anywhere — don't point at a tab that won't offer it either.
   */
  readOnlyTracker?: boolean;
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
 *
 * Read-only, like the per-period table beside it. Changing an entry is a
 * different kind of act from reading one, and it lives in one place — the
 * All entries tab — rather than being reachable from whichever view the user
 * happens to be on.
 */
export function EntryTable({
  tracker,
  entries,
  fields = [],
  notesByEntry,
  readOnlyTracker = false,
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
  // that costs a quarter of the width — so the Note column only exists when
  // something in this window actually carries one.
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
                windowPeriod={windowPeriod}
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
        {/* This view reads; it doesn't change anything. Say where changing
            lives, or the buttons look like they went missing. */}
        {!readOnlyTracker && ' Edit or delete on the All entries tab.'}
      </p>
    </div>
  );
}

/** One entry's row. */
function EntryTableRow({
  tracker,
  entry,
  note,
  chips,
  showChips,
  trail,
  isSnapshot,
  showNotes,
  windowPeriod,
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
  windowPeriod: BucketPeriod;
}) {
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
