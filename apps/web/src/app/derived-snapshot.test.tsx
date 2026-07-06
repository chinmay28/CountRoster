import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { toLocalISO } from '@countroster/core';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from '../pages/TrackerFormPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderApp(test: TestCore, initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'trackers/new', element: <TrackerFormPage /> },
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

/** Local-offset ISO for a (year, month, day) in the host timezone. */
function iso(year: number, month: number, day: number, hour = 12): string {
  return toLocalISO(new Date(year, month, day, hour));
}

/**
 * "Net worth" derived snapshot over two snapshot accounts, with readings
 * anchored to the *current* calendar month so the composition window
 * dropdown (which is built from the real clock) lines up:
 *
 *   Checking:  1000 two months ago · 1200 this month
 *   Brokerage:  500 last month (nothing since — it carries forward)
 */
async function netWorthFixture() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const checking = await test.createTracker({
    name: 'Checking',
    kind: 'number',
    is_snapshot: 1,
  });
  const brokerage = await test.createTracker({
    name: 'Brokerage',
    kind: 'number',
    is_snapshot: 1,
  });
  await test.core.entries.log(checking.id, {
    value: 1000,
    occurred_at: iso(y, m - 2, 15),
  });
  await test.core.entries.log(brokerage.id, {
    value: 500,
    occurred_at: iso(y, m - 1, 15),
  });
  // The 1st at 00:00:01 is always within the current month and never ahead
  // of "now", whatever today's date is.
  await test.core.entries.log(checking.id, {
    value: 1200,
    occurred_at: toLocalISO(new Date(y, m, 1, 0, 0, 1)),
  });
  const netWorth = await test.createTracker({
    name: 'Net worth',
    kind: 'number',
    is_snapshot: 1,
    links: [
      { source_id: checking.id, coefficient: 1 },
      { source_id: brokerage.id, coefficient: 1 },
    ],
  });
  return { checking, brokerage, netWorth };
}

describe('derived snapshot tracker detail', () => {
  it('headlines the combined current level, carrying quiet sources forward', async () => {
    const { netWorth } = await netWorthFixture();
    renderApp(test, `/trackers/${netWorth.id}`);

    // Latest Checking (1200) + Brokerage carried from last month (500).
    expect(await screen.findByText(/current value/)).toBeInTheDocument();
    const headline = document.querySelector('.detail__total')!;
    expect(headline.textContent).toBe('1700');

    // High/low describe the combined level over time: it walked
    // 1000 → 1500 → 1700, never a per-source raw reading.
    const summary = document.querySelector('.detail__summary') as HTMLElement;
    const high = within(summary).getByText('all-time high').closest('.detail__stat')!;
    expect(high.querySelector('dd')!.textContent).toBe('1700');
    const low = within(summary).getByText('all-time low').closest('.detail__stat')!;
    expect(low.querySelector('dd')!.textContent).toBe('1000');

    // The virtual entries read as the level history, not contributions.
    expect(
      screen.getByRole('heading', { name: /level history/i }),
    ).toBeInTheDocument();
  });

  it('shows the composition of the current level with monthly windows to step back', async () => {
    const { netWorth } = await netWorthFixture();
    const user = userEvent.setup();
    renderApp(test, `/trackers/${netWorth.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;

    // Current levels: Checking 1200 of 1700 (71%), Brokerage 500 (29%),
    // sorted highest share first.
    expect(await within(section).findByText(/1200 · 71%/)).toBeInTheDocument();
    expect(within(section).getByText(/500 · 29%/)).toBeInTheDocument();
    const legendLinks = section.querySelectorAll('.composition__item a');
    expect([...legendLinks].map((a) => a.textContent)).toEqual([
      'Checking',
      'Brokerage',
    ]);

    // The dropdown offers the current levels plus monthly windows back to
    // the first reading (month is the smallest snapshot window).
    const select = within(section).getByRole('combobox', { name: /period/i });
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels.slice(0, 3)).toEqual(['Current', 'This month', 'Last month']);

    // Last month: Checking had no reading yet that month — its reading from
    // two months ago carries: 1000 (67%) + Brokerage 500 (33%).
    await user.selectOptions(select, within(select).getByRole('option', { name: 'Last month' }));
    expect(await within(section).findByText(/1000 · 67%/)).toBeInTheDocument();
    expect(within(section).getByText(/500 · 33%/)).toBeInTheDocument();
    expect(
      within(section).getByText(/carry their last one/),
    ).toBeInTheDocument();
  });

  it('home card shows the combined current level', async () => {
    await netWorthFixture();
    renderApp(test, '/');

    await screen.findByText('Net worth');
    const card = screen.getByText('Net worth').closest('.tracker-card') as HTMLElement;
    expect(within(card).getByText('1700')).toBeInTheDocument();
    expect(within(card).getByText('current')).toBeInTheDocument();
  });
});

describe('derived snapshot creation through the form', () => {
  it('offers the snapshot stat option for a derived tracker', async () => {
    const checking = await test.createTracker({
      name: 'Checking',
      kind: 'number',
      is_snapshot: 1,
    });
    const brokerage = await test.createTracker({
      name: 'Brokerage',
      kind: 'number',
      is_snapshot: 1,
    });

    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Net worth');
    await user.click(screen.getByLabelText(/derived tracker/i));

    const sources = () => within(screen.getByRole('group', { name: /sources/i }));
    await user.click(screen.getByRole('button', { name: /add source/i }));
    await user.selectOptions(sources().getAllByRole('combobox')[0]!, checking.id);
    await user.click(screen.getByRole('button', { name: /add source/i }));
    await user.selectOptions(sources().getAllByRole('combobox')[1]!, brokerage.id);

    await user.selectOptions(
      screen.getByLabelText('Reset every'),
      screen.getByRole('option', { name: /snapshot stat/i }),
    );
    await user.click(screen.getByRole('button', { name: /create tracker/i }));

    expect(
      await screen.findByRole('heading', { name: 'Net worth' }),
    ).toBeInTheDocument();
    const all = await test.core.trackers.list();
    const created = all.find((t) => t.name === 'Net worth')!;
    expect(created.is_derived).toBe(1);
    expect(created.is_snapshot).toBe(1);
    expect(created.reset_period).toBe('never');
  });
});
