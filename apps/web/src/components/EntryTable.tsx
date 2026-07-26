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
 * shape as the per-period breakdown, one row down. Where that table compares
 * each period with the period before it, this one compares each entry with
 * the entry before it, so the two read the same way at both scales.
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

  // Each row against the one before it, then flipped: the table reads newest
  // first, like the per-period one. The oldest entry in the window has
  // nothing behind it to compare against — whatever came before it belongs
  // to a window this table isn't showing.
  const rows = entries
    .map((entry, i) => {
      const previous = i > 0 ? entries[i - 1]! : null;
      return {
        entry,
        note: notesByEntry?.get(entry.id)?.[0] ?? null,
        chips: entryChips(entry, fields),
        change: previous ? entry.value - previous.value : null,
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
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, note, chips, change }) => (
              <EntryTableRow
                key={entry.id}
                tracker={tracker}
                entry={entry}
                note={note}
                chips={chips}
                showChips={showChips}
                change={change}
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
  change,
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
  /** Step from the entry before it; null for the window's first. */
  change: number | null;
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
        {change === null ? (
          <span className="muted">—</span>
        ) : (
          <Step tracker={tracker} delta={change} />
        )}
      </td>
    </tr>
  );
}

/** The move since the entry before, as an arrow and a magnitude. */
function Step({ tracker, delta }: { tracker: Tracker; delta: number }) {
  if (delta === 0) return <span className="muted">±0</span>;
  return (
    <span className={delta > 0 ? 'periods__up' : 'periods__down'}>
      {delta > 0 ? '▲' : '▼'} {formatValue(tracker, Math.abs(delta))}
    </span>
  );
}
