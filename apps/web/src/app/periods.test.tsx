import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('current-period tab', () => {
  /**
   * The current-window panel, named after the window on show — the tab that
   * labels it is renamed as the view steps back, so "Today" becomes
   * "Yesterday" becomes a date.
   */
  function windowPanel(label: string): HTMLElement {
    return screen.getByRole('tabpanel', { name: label });
  }

  /** The entry table's body rows, as arrays of cell text. */
  function windowRows(label: string): string[][] {
    const table = within(screen.getByRole('tabpanel', { name: label })).getByRole('table');
    return within(table)
      .getAllByRole('row')
      .slice(1) // drop the header
      .map((row) =>
        [
          ...within(row).queryAllByRole('rowheader'),
          ...within(row).queryAllByRole('cell'),
        ].map((cell) => cell.textContent?.trim() ?? ''),
      );
  }

  it('opens on the reset window and tabulates only its entries', async () => {
    const tracker = await seedDaily(test);
    renderApp(test, `/trackers/${tracker.id}`);

    // A daily tracker's current window is today, and that is the default tab.
    expect(await screen.findByRole('tab', { name: 'Today' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const other of ['By period', 'All entries']) {
      expect(screen.getByRole('tab', { name: other })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    }

    const table = within(screen.getByRole('tabpanel', { name: 'Today' })).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'Value', 'Change']);

    // Three entries all told, but only today's two are tabulated — newest
    // first, each compared with the entry before it.
    const rows = windowRows('Today');
    expect(rows).toHaveLength(3); // 2 entries + the footer
    expect(rows[0]![1]).toBe('2 glasses'); // 14:00, the later of the two
    expect(rows[0]![2]).toContain('▲ 1 glasses'); // up from the 09:00 entry
    expect(rows[1]![1]).toBe('1 glasses'); // 09:00
    // The window's first entry has nothing behind it to compare against.
    expect(rows[1]![2]).toBe('—');
    expect(rows[2]!.slice(0, 2)).toEqual(['2 entries', '3 glasses']);
  });

  it('names the window after the tracker’s reset period', async () => {
    for (const [reset, label] of [
      ['weekly', 'This week'],
      ['monthly', 'This month'],
      ['yearly', 'This year'],
    ] as const) {
      const t = await makeTestCore();
      const tracker = await t.createTracker({ name: reset, kind: 'count', reset_period: reset });
      const view = renderApp(t, `/trackers/${tracker.id}`);
      expect(await screen.findByRole('tab', { name: label })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      view.unmount();
    }
  });

  it('quotes progress toward the target for the window', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
      target: 8,
      unit: 'glasses',
    });
    await test.core.entries.log(tracker.id, { value: 6, occurred_at: daysAgo(0, 9) });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    expect(windowRows('Today').at(-1)).toEqual(['1 entry', '6 glasses', '75%']);
    expect(screen.getByRole('tabpanel', { name: 'Today' })).toHaveTextContent(
      '6 glasses of the 8 glasses target today.',
    );
  });

  it('says the window is empty rather than the tracker is', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
    });
    // Logged, but not today — "no entries yet" would be a false claim.
    await test.core.entries.log(tracker.id, { value: 4, occurred_at: daysAgo(3, 10) });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    const panel = screen.getByRole('tabpanel', { name: 'Today' });
    expect(panel).toHaveTextContent('Nothing logged today yet.');
    expect(panel).not.toHaveTextContent('No entries yet.');
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the note attached to an entry in its own column', async () => {
    const tracker = await test.createTracker({
      name: 'Spend',
      kind: 'number',
      reset_period: 'monthly',
      unit: '$',
    });
    const entry = await test.core.entries.log(tracker.id, {
      value: 12,
      occurred_at: daysAgo(0, 9),
    });
    await test.core.notes.create({
      tracker_id: tracker.id,
      entry_id: entry.id,
      body: 'Coffee beans',
    });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'This month' });
    expect(windowRows('This month')[0]![2]).toBe('Coffee beans');
    // The Notes column only exists because this entry carries one.
    expect(
      within(within(screen.getByRole('tabpanel', { name: 'This month' })).getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'Value', 'Notes', 'Change']);
  });

  it('reads an entry’s answers and its note out of one Notes column', async () => {
    const tracker = await test.createTracker({
      name: 'Milk',
      kind: 'number',
      reset_period: 'daily',
      unit: 'ml',
    });
    const [wetDiaper] = await test.core.fields.replace(tracker.id, [
      { name: 'Wet diaper', kind: 'flag' },
    ]);
    const entry = await test.core.entries.log(tracker.id, {
      value: 70,
      occurred_at: daysAgo(0, 9),
      fields: { [wetDiaper!.id]: true },
    });
    await test.core.notes.create({
      tracker_id: tracker.id,
      entry_id: entry.id,
      body: '+Multivitamin',
    });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    const table = within(screen.getByRole('tabpanel', { name: 'Today' })).getByRole('table');
    // One column, not two: the answer and the note stack in the same cell.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'Value', 'Notes', 'Change']);
    const cell = within(table).getByText('+Multivitamin').closest('td')!;
    expect(within(cell).getByText('✓ Wet diaper')).toBeInTheDocument();
  });

  it('steps a window at a time, stopping at now and at the first entry', async () => {
    const tracker = await seedDaily(test); // 3 today, 4 yesterday, none before
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    // The tab renames itself as the window moves, so the panel it labels is
    // addressed by the window on show.
    const next = (label: string) =>
      within(windowPanel(label)).getByRole('button', { name: 'Next day' });
    const previous = (label: string) =>
      within(windowPanel(label)).getByRole('button', { name: 'Previous day' });

    // The latest window sits on the left, the way the table above it reads:
    // newest first, older below. ‹ walks toward today, › into the past.
    expect(
      within(windowPanel('Today'))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Next day', 'Previous day']);

    // Today is the window in progress: there is no day after it to show.
    expect(next('Today')).toBeDisabled();
    expect(previous('Today')).toBeEnabled();
    expect(windowRows('Today').at(-1)!.slice(0, 2)).toEqual(['2 entries', '3 glasses']);

    await user.click(previous('Today'));
    // Yesterday's own entry, and yesterday's own total.
    expect(windowRows('Yesterday').at(-1)!.slice(0, 2)).toEqual(['1 entry', '4 glasses']);
    expect(windowPanel('Yesterday')).toHaveTextContent('Everything logged yesterday.');
    expect(next('Yesterday')).toBeEnabled();
    // Nothing was logged before yesterday, so back is the end of the road.
    expect(previous('Yesterday')).toBeDisabled();

    await user.click(next('Yesterday'));
    expect(windowRows('Today').at(-1)!.slice(0, 2)).toEqual(['2 entries', '3 glasses']);
    expect(next('Today')).toBeDisabled();
  });

  it('renames the tab after the window on show', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    const tab = await screen.findByRole('tab', { name: 'Today' });
    await user.click(
      within(windowPanel('Today')).getByRole('button', { name: 'Previous day' }),
    );
    // Same tab, renamed — the panel under it is yesterday's, so saying
    // "Today" would label it wrong.
    expect(tab).toHaveAccessibleName('Yesterday');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(windowPanel('Yesterday')).toHaveAccessibleName('Yesterday');
    // The other two tabs are untouched by where the window sits.
    for (const other of ['By period', 'All entries']) {
      expect(screen.getByRole('tab', { name: other })).toBeInTheDocument();
    }

    // Off the current window, the tab is the way home — and says so.
    expect(tab).toHaveAttribute('title', 'Back to today');
    await user.click(tab);
    expect(tab).toHaveAccessibleName('Today');
    expect(tab).not.toHaveAttribute('title');
  });

  it('names the window it stepped into, and says a past one is over', async () => {
    const tracker = await test.createTracker({
      name: 'Water',
      kind: 'count',
      reset_period: 'daily',
      unit: 'glasses',
    });
    // A gap: today and four days ago, nothing between.
    await test.core.entries.log(tracker.id, { value: 2, occurred_at: daysAgo(0, 9) });
    await test.core.entries.log(tracker.id, { value: 5, occurred_at: daysAgo(4, 9) });
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    const stepBack = (from: string) =>
      user.click(within(windowPanel(from)).getByRole('button', { name: 'Previous day' }));

    await stepBack('Today');
    // An empty day that has already ended logged nothing — not "nothing yet".
    const yesterday = windowPanel('Yesterday');
    expect(yesterday).toHaveTextContent('Nothing logged yesterday.');
    expect(yesterday).not.toHaveTextContent('yesterday yet');
    // …and the controls survive the empty window, or there'd be no way back.
    expect(within(yesterday).getByRole('button', { name: 'Next day' })).toBeEnabled();

    await stepBack('Yesterday');
    // Past the two relative names, a window goes by its date.
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const dated = twoDaysAgo.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    expect(within(windowPanel(dated)).getByText(dated)).toBeInTheDocument();

    // The tab is also the way home from wherever the stepping ended up — by
    // then it is carrying the date it walked to.
    await user.click(screen.getByRole('tab', { name: dated }));
    expect(
      within(windowPanel('Today')).getByRole('button', { name: 'Next day' }),
    ).toBeDisabled();
  });

  it('steps in the unit the tracker resets in', async () => {
    const tracker = await test.createTracker({
      name: 'Spend',
      kind: 'number',
      reset_period: 'monthly',
      unit: '$',
    });
    await test.core.entries.log(tracker.id, { value: 12, occurred_at: daysAgo(0, 9) });
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'This month' });
    const panel = () => screen.getByRole('tabpanel', { name: 'This month' });
    expect(within(panel()).getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Previous day' })).toBeNull();
    // The only entry is in this month, so there is no earlier month to reach.
    expect(within(panel()).getByRole('button', { name: 'Previous month' })).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: 'All entries' }));
    // Stepping is the current-window tab's affordance; the raw timeline and
    // the per-period table each already show every window at once.
    expect(
      within(screen.getByRole('tabpanel', { name: 'All entries' })).queryByRole('button', {
        name: 'Previous month',
      }),
    ).toBeNull();
  });

  it('reads but never writes — editing belongs to the All entries tab', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'Today' });
    const panel = screen.getByRole('tabpanel', { name: 'Today' });
    for (const action of ['Edit', 'Delete']) {
      expect(within(panel).queryByRole('button', { name: action })).not.toBeInTheDocument();
    }
    // …and says where they went, so they don't look mislaid.
    expect(panel).toHaveTextContent('Edit or delete on the All entries tab.');

    await user.click(screen.getByRole('tab', { name: 'All entries' }));
    const timeline = screen.getByRole('tabpanel', { name: 'All entries' });
    expect(within(timeline).getAllByRole('button', { name: 'Edit' })).not.toHaveLength(0);
    expect(within(timeline).getAllByRole('button', { name: 'Delete' })).not.toHaveLength(0);
  });

  it('reads a snapshot tracker’s window as levels, not a sum', async () => {
    const tracker = await test.createTracker({
      name: 'Weight',
      kind: 'number',
      is_snapshot: 1,
      unit: 'lb',
    });
    await test.core.entries.log(tracker.id, { value: 181, occurred_at: daysAgo(0, 8) });
    await test.core.entries.log(tracker.id, { value: 179, occurred_at: daysAgo(0, 20) });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'This month' });
    const table = within(screen.getByRole('tabpanel', { name: 'This month' })).getByRole(
      'table',
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'Reading', 'Change']);

    const rows = windowRows('This month');
    // Newest first: 179 is a 2 lb drop from the 181 before it…
    expect(rows[0]![1]).toBe('179 lb');
    expect(rows[0]![2]).toContain('▼ 2 lb');
    // …and the first reading of the window has nothing to step from.
    expect(rows[1]![2]).toBe('—');
    // A level's step and an amount's step are the same column now.
    // The "total" is the latest level — 181 + 179 would be nonsense.
    expect(rows[2]!.slice(0, 2)).toEqual(['2 entries', '179 lb']);
  });
});

describe('period table', () => {
  it('totals each period, and compares it with the one before', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);
    await user.click(await screen.findByRole('tab', { name: 'By period' }));

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

  it('hides empty periods until asked to show them', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);
    await user.click(await screen.findByRole('tab', { name: 'By period' }));
    await screen.findByRole('table');
    // The table opens filtered: header + the two logged days + footer.
    const toggle = screen.getByLabelText('Hide empty periods');
    expect(toggle).toBeChecked();
    expect(tableRows()).toHaveLength(4);
    expect(screen.queryByText('—')).not.toBeInTheDocument();

    // Unticking brings the gaps back — 12 days shown, only 2 with entries.
    await user.click(toggle);
    expect(tableRows().length).toBeGreaterThan(4);
  });

  it('re-buckets when the period changes', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);
    await user.click(await screen.findByRole('tab', { name: 'By period' }));
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

  it('falls back to months for a tracker with no reset window', async () => {
    const tracker = await test.createTracker({ name: 'Books', kind: 'count' });
    await test.core.entries.log(tracker.id, { value: 1 });
    renderApp(test, `/trackers/${tracker.id}`);

    // No reset period means no "today"/"this week" to speak of; the current
    // window is the month, and it is still what the page opens on.
    expect(await screen.findByRole('tab', { name: 'This month' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // That tab's table lists entries, not periods.
    expect(
      within(screen.getByRole('table')).getByRole('columnheader', { name: 'Time' }),
    ).toBeInTheDocument();
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

    // A snapshot tracker resets 'never', so its table opens on months — the
    // fallback for a tracker with no reset window.
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
    // claim the user weighed nothing. Empty days are filtered out by default,
    // so ask for them back before reading one.
    await user.click(screen.getByLabelText('Hide empty periods'));
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
    const user = userEvent.setup();
    renderApp(test, `/trackers/${tracker.id}`);
    await user.click(await screen.findByRole('tab', { name: 'By period' }));

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
    await user.click(await screen.findByRole('tab', { name: 'By period' }));

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

    await user.click(await screen.findByRole('tab', { name: 'By period' }));
    const footer = () =>
      within(screen.getByRole('table')).getAllByRole('row').at(-1)!;
    await screen.findByRole('table');
    // Empty periods are hidden to begin with, so the footer counts the two
    // days on screen rather than the twelve the range reaches back over.
    expect(footer()).toHaveTextContent('2 days');
    // The total is unchanged — the hidden periods contributed nothing.
    expect(footer()).toHaveTextContent('7 glasses');

    await user.click(screen.getByLabelText('Hide empty periods'));
    expect(footer()).toHaveTextContent('12 days');
    expect(footer()).toHaveTextContent('7 glasses');
  });
});

describe('section arranging', () => {
  it('reorders the detail page and persists the order on the tracker', async () => {
    const tracker = await seedDaily(test);
    const user = userEvent.setup();
    const view = renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('tab', { name: 'By period' });
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
