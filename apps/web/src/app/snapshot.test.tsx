import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
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

/** A net-worth-style tracker with three readings: 500 → 900 → 700. */
async function seedSnapshot(t: TestCore) {
  const tracker = await t.createTracker({
    name: 'Net worth',
    kind: 'number',
    is_snapshot: 1,
  });
  await t.core.entries.log(tracker.id, {
    value: 500,
    occurred_at: '2026-03-10T10:00:00.000-07:00',
  });
  await t.core.entries.log(tracker.id, {
    value: 900,
    occurred_at: '2026-04-10T10:00:00.000-07:00',
  });
  await t.core.entries.log(tracker.id, {
    value: 700,
    occurred_at: '2026-05-10T10:00:00.000-07:00',
  });
  return tracker;
}

describe('snapshot trackers in the form', () => {
  it('creates a snapshot tracker via the "Reset every" select', async () => {
    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Net worth');
    await user.selectOptions(
      screen.getByLabelText('Reset every'),
      screen.getByRole('option', { name: /snapshot stat/i }),
    );
    await user.click(screen.getByRole('button', { name: /create tracker/i }));

    expect(await screen.findByRole('heading', { name: 'Net worth' })).toBeInTheDocument();
    const [tracker] = await test.core.trackers.list();
    expect(tracker!.is_snapshot).toBe(1);
    expect(tracker!.reset_period).toBe('never');
  });
});

describe('snapshot tracker detail page', () => {
  it('headlines the latest reading and shows all-time high/low', async () => {
    const tracker = await seedSnapshot(test);
    renderApp(test, `/trackers/${tracker.id}`);

    // Headline is the most recent reading, not the 2100 sum.
    expect(await screen.findByText(/current value/)).toBeInTheDocument();
    const headline = document.querySelector('.detail__total')!;
    expect(headline.textContent).toBe('700');

    // The statistics box reports extremes instead of this-week/this-month.
    const summary = document.querySelector('.detail__summary') as HTMLElement;
    expect(within(summary).getByText('all-time high')).toBeInTheDocument();
    const high = within(summary).getByText('all-time high').closest('.detail__stat')!;
    expect(high.querySelector('dd')!.textContent).toBe('900');
    const low = within(summary).getByText('all-time low').closest('.detail__stat')!;
    expect(low.querySelector('dd')!.textContent).toBe('500');
    expect(within(summary).queryByText('this week')).not.toBeInTheDocument();

    // Header says it's a snapshot stat.
    expect(screen.getByText(/snapshot stat/)).toBeInTheDocument();
  });

  it('renders a zoomable level chart in trends, without period buckets', async () => {
    const tracker = await seedSnapshot(test);
    renderApp(test, `/trackers/${tracker.id}`);

    // The stat card swaps the streak for the extremes.
    expect(await screen.findByText(/all-time high · all-time low/)).toBeInTheDocument();
    expect(screen.queryByText(/day streak/)).not.toBeInTheDocument();

    // No Day/Week/Month/Year toggle — levels aren't bucketed into periods.
    for (const label of ['Day', 'Week', 'Month', 'Year']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }

    // All three readings chart on a continuous time axis.
    expect(
      await screen.findByRole('img', { name: /net worth level over time/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/all history · 3 readings/)).toBeInTheDocument();

    // Zoom out is a no-op at full history; zoom in halves the window
    // (anchored at the latest reading), dropping the oldest reading.
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(
      await screen.findByText(/zoomed to the latest 2 of 3 readings/),
    ).toBeInTheDocument();
    // Two readings left: nothing more to zoom into.
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();

    // And back out to everything.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(await screen.findByText(/all history · 3 readings/)).toBeInTheDocument();
  });
});

describe('snapshot tracker home card', () => {
  it('shows the latest reading labelled "current"', async () => {
    await seedSnapshot(test);
    renderApp(test, '/');

    await screen.findByText('Net worth');
    const card = screen.getByText('Net worth').closest('.tracker-card') as HTMLElement;
    expect(within(card).getByText('700')).toBeInTheDocument();
    expect(within(card).getByText('current')).toBeInTheDocument();
  });
});
