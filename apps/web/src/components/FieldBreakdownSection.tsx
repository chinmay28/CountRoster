import { useMemo, useState } from 'react';
import type { Tracker, TrackerField } from '@countroster/core';
import { useCore } from '../app/CoreContext.tsx';
import { useAsync } from '../app/useAsync.ts';
import { formatValue } from '../lib/format.ts';
import { percentShares } from '../lib/donut.ts';
import { resetPeriodOptions } from '../lib/range.ts';
import { chartableFields, sliceColor } from '../lib/fields.ts';

interface FieldBreakdownSectionProps {
  tracker: Tracker;
  fields: readonly TrackerField[];
  /**
   * The tracker's entries, oldest first. Their instants bound the period
   * dropdown the same way the composition card's does.
   */
  entries: readonly { occurred_at: string }[];
  /** Bumped on any write so the breakdown re-fetches with the entry list. */
  refreshKey?: number;
}

/**
 * "Breakdown" card: how the tracker's total splits across the answers of one
 * custom field — the milk tracker's millilitres by bottle / formula / breast,
 * or by whether the diaper was wet.
 *
 * A stacked bar rather than the composition donut: a field can carry a dozen
 * options, and a bar keeps its legend readable at that width on a phone.
 */
export function FieldBreakdownSection({
  tracker,
  fields,
  entries,
  refreshKey = 0,
}: FieldBreakdownSectionProps) {
  const core = useCore();
  const chartable = useMemo(() => chartableFields(fields), [fields]);
  const [fieldId, setFieldId] = useState('');
  const [selected, setSelected] = useState('all');

  // The dropdown's default follows the field list rather than pinning to a
  // field that may have just been renamed away.
  const active = chartable.find((f) => f.id === fieldId) ?? chartable[0] ?? null;

  const options = useMemo(() => {
    // A tracker that never resets still deserves a way to scope the
    // breakdown, so fall back to months rather than offering nothing. The
    // tracker itself carries the window shape (week/month/year starts).
    const windows = resetPeriodOptions(
      tracker.reset_period === 'never' ? 'monthly' : tracker.reset_period,
      tracker,
      entries[0]?.occurred_at,
    );
    // Only windows something was logged in — the rest are empty bars.
    const instants = entries.map((e) => new Date(e.occurred_at).getTime());
    return windows.filter((o) => {
      const start = new Date(o.range.start).getTime();
      const end = new Date(o.range.end).getTime();
      return instants.some((t) => t >= start && t < end);
    });
    // Depend on the window fields rather than the tracker object, so a
    // refetch that returns identical values doesn't rebuild the list.
  }, [
    tracker.reset_period,
    tracker.week_start,
    tracker.day_start_minute,
    tracker.month_start_day,
    tracker.year_start_month,
    entries,
  ]);
  const window = options.find((o) => o.value === selected);

  const { data: slices } = useAsync(
    () =>
      active
        ? core.stats.fieldBreakdown(tracker.id, active.id, window?.range)
        : Promise.resolve([]),
    [tracker.id, active?.id, window?.range.start, window?.range.end, refreshKey],
  );

  if (chartable.length === 0 || !active) return null;

  const rows = slices ?? [];
  const total = rows.reduce((sum, s) => sum + s.total, 0);
  const shares = percentShares(rows.map((s) => Math.max(0, s.total)));

  return (
    <section className="detail__breakdown card">
      <div className="breakdown__head">
        <h2>Breakdown</h2>
        <div className="breakdown__selects">
          {chartable.length > 1 && (
            <select
              aria-label="Breakdown field"
              value={active.id}
              onChange={(e) => setFieldId(e.target.value)}
            >
              {chartable.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
          {options.length > 0 && (
            <select
              aria-label="Breakdown period"
              value={window ? selected : 'all'}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="all">All time</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <p className="muted breakdown__subtitle">
        {tracker.name} by {active.name.toLowerCase()}
        {window ? `, ${window.label.toLowerCase()}` : ''}.
      </p>

      {total === 0 ? (
        <p className="muted">
          {window ? 'Nothing logged in this period.' : 'Nothing logged yet.'}
        </p>
      ) : (
        <>
          <div
            className="breakdown__bar"
            role="img"
            aria-label={rows
              .filter((s) => s.total > 0)
              .map((s, i) => `${s.label} ${shares[rows.indexOf(s)] ?? 0}%`)
              .join(', ')}
          >
            {rows.map((slice, i) =>
              slice.total > 0 ? (
                <span
                  key={slice.key || 'unset'}
                  className="breakdown__segment"
                  style={{
                    width: `${shares[i]}%`,
                    // The unanswered bucket is deliberately drab: it's the
                    // absence of data, not another category.
                    background: slice.key === '' ? 'var(--border)' : sliceColor(slice.color, i),
                  }}
                  title={`${slice.label}: ${formatValue(tracker, slice.total)} (${shares[i]}%)`}
                />
              ) : null,
            )}
          </div>
          <ul className="breakdown__legend">
            {rows.map((slice, i) => (
              <li key={slice.key || 'unset'} className="breakdown__item">
                <span
                  className="breakdown__swatch"
                  style={{
                    background: slice.key === '' ? 'var(--border)' : sliceColor(slice.color, i),
                  }}
                  aria-hidden="true"
                />
                <span className="breakdown__name">{slice.label}</span>
                <span className="muted breakdown__share">
                  {formatValue(tracker, slice.total)} · {shares[i]}% ·{' '}
                  {slice.count} {slice.count === 1 ? 'entry' : 'entries'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
