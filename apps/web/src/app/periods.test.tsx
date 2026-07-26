import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderApp(test: TestCore, initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'trackers/:id', element: <TrackerDetailPage /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
  return render(
    <CoreValueProvider value={{ core: test.core, connected: true }}>
      <RouterProvider router={router} />
    </CoreValueProvider>,
  );
}

let test: TestCore;
beforeEach(async () => {
  test = await makeTestCore();
});

/** ISO for `daysAgo` days before now, at midday local — safely inside a day. */
function daysAgo(days: number, hour = 12): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** A daily-resetting tracker: 3 today (two entries), 4 yesterday, none before. */
async function seedDaily(t: TestCore) {
  const tracker = await t.createTracker({
    name: 'Water',
    kind: 'count',
    reset_period: 'daily',
    unit: 'glasses',
  });
  await t.core.entries.log(tracker.id, { value: 1, occurred_at: daysAgo(0, 9) });
  await t.core.entries.log(tracker.id, { value: 2, occurred_at: daysAgo(0, 14) });
  await t.core.entries.log(tracker.id, { value: 4, occurred_at: daysAgo(1, 10) });
  return tracker;
}

/** The rendered rows of the period table, as arrays of cell text. */
function tableRows(): string[][] {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('row')
    .map((row) =>
      within(row)
        .getAllByRole(row.closest('thead') ? 'columnheader' : 'cell')
        .concat(within(row).queryAllByRole('rowheader'))
        .map((cell) => cell.textContent?.trim() ?? ''),
    );
}

describe('period table', () => {
  it('is the default view for a tracker that resets, and totals each period', async () => {
    const tracker = await seedDaily(test);
    renderApp(test, `/trackers/${tracker.id}`);

    expect(await screen.findByRole('tab', { name: 'By period' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'All entries' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    const table = await screen.findByRole('table');
    const today = within(table).getByRole('rowheader', { name: 'Today' }).closest('tr')!;
    // Two entries today summing to 3.
    expect(within(today).getAllByRole('cell')[0]).toHaveTextContent('3 glasses');
    expect(within(today).getAllByRole('cell')[1]).toHaveTextContent('2');
    // Yesterday's 4 is one entry, and today is 1 below it.
    const yesterday = within(table)
      .getByRole('rowheader', { name: 'Yesterday' })
      .closest('tr')!;
    expect(within(yesterday).getAllByRole('cell')[0]).toHaveTextContent('4 glasses');
    expect(within(today).getAllByRole('cell')[2]).toHaveTextContent('▼ 1 glass');
  });

  it('shows empty periods until asked to hide them', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('table');
    const before = tableRows().length;
    // 12 days shown, only 2 of which have entries.
    expect(before).toBeGreaterThan(4);

    await user.click(screen.getByLabelText('Hide empty periods'));
    // Header + the two logged days + footer.
    expect(tableRows()).toHaveLength(4);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('re-buckets when the period changes', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('table');
    // The Trends panel has its own Day/Week/Month/Year toggle; use the table's.
    const periods = screen.getByRole('group', { name: 'Table period' });
    await user.click(within(periods).getByRole('button', { name: 'Month' }));

    const table = await screen.findByRole('table');
    // Everything logged in the last two days lands in one month bucket…
    const thisMonth = within(table)
      .getByRole('rowheader', { name: 'This month' })
      .closest('tr')!;
    expect(within(thisMonth).getAllByRole('cell')[1]).toHaveTextContent('3');
  });

  it('keeps the raw timeline (and its editing) on the other tab', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await user.click(await screen.findByRole('tab', { name: 'All entries' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The entry list's per-entry controls are back.
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0);
  });

  it('opens on the timeline for a tracker that never resets', async () => {
    const tracker = await test.createTracker({ name: 'Books', kind: 'count' });
    await test.core.entries.log(tracker.id, { value: 1 });
    renderApp(test, `/trackers/${tracker.id}`);

    expect(await screen.findByRole('tab', { name: 'All entries' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reads a snapshot tracker as levels, not sums', async () => {
    const tracker = await test.createTracker({
      name: 'Weight',
      kind: 'number',
      is_snapshot: 1,
      unit: 'lb',
    });
    await test.core.entries.log(tracker.id, { value: 181, occurred_at: daysAgo(0, 8) });
    await test.core.entries.log(tracker.id, { value: 179, occurred_at: daysAgo(0, 20) });
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    // A snapshot tracker resets 'never', so the table isn't the default tab —
    // and it opens on months, the fallback for a tracker with no reset window.
    await user.click(await screen.findByRole('tab', { name: 'By period' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Table period' })).getByRole('button', {
        name: 'Day',
      }),
    );

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Latest' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Range' })).toBeInTheDocument();
    const today = within(table).getByRole('rowheader', { name: 'Today' }).closest('tr')!;
    const cells = within(today).getAllByRole('cell');
    // The closing reading, the spread it moved through, and the count — the
    // day's two readings must not add up to 360.
    expect(cells[0]).toHaveTextContent('179 lb');
    expect(cells[1]).toHaveTextContent('179 lb–181 lb');
    expect(cells[2]).toHaveTextContent('2');

    // A level persists, so the day after a reading still shows it — but a day
    // *before* the first reading ever has no level to show, and must not
    // claim the user weighed nothing.
    const rows = within(table).getAllByRole('row');
    const preHistory = rows.at(-2)!; // last body row; the footer is last
    expect(within(preHistory).getAllByRole('cell')[0]).toHaveTextContent('—');
    expect(within(preHistory).getAllByRole('cell')[0]).not.toHaveTextContent('0 lb');
  });

  it('shows target progress per period when the tracker has a target', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
      target: 8,
    });
    await test.core.entries.log(tracker.id, { value: 6, occurred_at: daysAgo(0, 9) });
    renderApp(test, `/trackers/${tracker.id}`);

    const table = await screen.findByRole('table');
    const today = within(table).getByRole('rowheader', { name: 'Today' }).closest('tr')!;
    expect(within(today).getAllByRole('cell')[3]).toHaveTextContent('75%');
  });

  it('drops the target column on a period the target does not describe', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
      target: 8,
    });
    await test.core.entries.log(tracker.id, { value: 6, occurred_at: daysAgo(0, 9) });
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    expect(
      within(await screen.findByRole('table')).getByRole('columnheader', { name: 'of 8' }),
    ).toBeInTheDocument();
    const periods = screen.getByRole('group', { name: 'Table period' });

    // A daily target says nothing about a week's total — 6 of 8 per day would
    // read as 75% weekly too, which is simply a different (wrong) claim.
    await user.click(within(periods).getByRole('button', { name: 'Week' }));
    expect(
      within(await screen.findByRole('table')).queryByRole('columnheader', { name: 'of 8' }),
    ).not.toBeInTheDocument();
  });

  it('narrows the footer to the periods actually on screen', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    const footer = () =>
      within(screen.getByRole('table')).getAllByRole('row').at(-1)!;
    await screen.findByRole('table');
    expect(footer()).toHaveTextContent('12 days');

    await user.click(screen.getByLabelText('Hide empty periods'));
    expect(footer()).toHaveTextContent('2 days');
    // The total is unchanged — the hidden periods contributed nothing.
    expect(footer()).toHaveTextContent('7 glasses');
  });
});

describe('section arranging', () => {
  it('reorders the detail page and persists the order on the tracker', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    const view = renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Arrange' }));

    const list = screen.getByRole('list', { name: 'Page sections' });
    expect(
      within(list)
        .getAllByRole('listitem')
        // Each row leads with the drag handle's grip glyph.
        .map((li) => li.textContent?.replace('⠿', '')),
    ).toEqual(['Summary', 'Trends', 'Log an entry', 'Entries', 'Notes']);

    // Drag isn't reproducible in jsdom; drive the same write the drop does.
    await test.core.trackers.update(tracker.id, {
      section_order: 'entries,summary,trends,log,notes',
    });
    const stored = await test.core.trackers.get(tracker.id);
    expect(stored?.section_order).toBe('entries,summary,trends,log,notes');

    // Re-render from scratch: the sections now follow the stored order.
    view.unmount();
    renderApp(test, `/trackers/${tracker.id}`);
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.textContent,
    );
    expect(headings.indexOf('Entries')).toBeLessThan(headings.indexOf('Trends'));
  });

  it('resets a rearranged page back to the default order', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
      section_order: 'notes,entries,summary,trends,log',
    });
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('heading', { name: 'Water' });
    let headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Notes')).toBeLessThan(headings.indexOf('Entries'));

    await user.click(screen.getByRole('button', { name: 'Arrange' }));
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));

    // Cleared on the tracker, so the page follows the default order as it
    // evolves rather than being pinned to today's one.
    await screen.findByRole('button', { name: 'Reset to default' });
    expect((await test.core.trackers.get(tracker.id))?.section_order).toBeNull();
    headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Entries')).toBeLessThan(headings.indexOf('Notes'));
  });

  it('ignores a stored order naming sections this tracker has no room for', async () => {
    // 'log' is meaningless for a derived tracker: its entries are computed.
    const source = await test.createTracker({ name: 'Revenue', kind: 'number' });
    const derived = await test.createTracker({
      name: 'Profit',
      kind: 'number',
      links: [{ source_id: source.id, coefficient: 1 }],
      section_order: 'log,entries,summary',
    });
    renderApp(test, `/trackers/${derived.id}`);

    await screen.findByRole('heading', { name: 'Profit' });
    expect(screen.queryByRole('tab', { name: 'Log an entry' })).not.toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toContain('Derived from');
  });
});
