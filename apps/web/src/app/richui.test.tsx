import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { GroupsPage } from '../pages/GroupsPage.tsx';
import { ComparePage } from '../pages/ComparePage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';
import { lastNBuckets } from '../lib/range.ts';

function renderApp(test: TestCore, initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'trackers/:id', element: <TrackerDetailPage /> },
          { path: 'groups', element: <GroupsPage /> },
          { path: 'compare', element: <ComparePage /> },
          { path: '*', element: <NotFoundPage /> },
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

describe('stats panel', () => {
  it('shows a streak and renders chart bars after logging', async () => {
    const t = await test.createTracker({ name: 'Water', kind: 'number' });
    await test.core.entries.log(t.id, { value: 4 });

    renderApp(test, `/trackers/${t.id}`);

    // Streak card reflects today's log.
    expect(await screen.findByText(/day streak/i)).toBeInTheDocument();
    // The bucket chart renders (role="img") rather than the empty-state text.
    const chart = await screen.findByRole('img', { name: /water totals by day/i });
    expect(chart).toBeInTheDocument();
  });

  it('orders the Month trend chart chronologically, not by data order', async () => {
    const t = await test.createTracker({ name: 'Sleep', kind: 'number' });
    await test.core.entries.log(t.id, { value: 7 });

    // The expected x-axis labels are the core's chronological month buckets,
    // formatted the way the chart formats them. Computing them here (rather than
    // hardcoding month names) keeps the test correct whatever day it runs.
    const range = lastNBuckets('month', 6, t.week_start);
    const buckets = await test.core.stats.bucket(t.id, range, 'month');
    const expected = buckets.map((b) =>
      new Date(b.start).toLocaleDateString(undefined, { month: 'short' }),
    );

    const { container } = renderApp(test, `/trackers/${t.id}`);

    // Switch the Trends panel to the Month period.
    await userEvent.click(await screen.findByRole('button', { name: 'Month' }));

    const chart = await screen.findByRole('img', { name: /sleep totals by month/i });
    await waitFor(() => {
      const labels = [
        ...chart.querySelectorAll('g[aria-label="x-axis tick label"] text'),
      ].map((n) => n.textContent ?? '');
      expect(labels).toEqual(expected);
    });
  });

  it('shows target progress when the tracker has a target', async () => {
    const t = await test.createTracker({
      name: 'Steps',
      kind: 'number',
      target: 10,
      reset_period: 'daily',
    });
    await test.core.entries.log(t.id, { value: 5 });

    renderApp(test, `/trackers/${t.id}`);
    expect(await screen.findByText(/this period · 50%/i)).toBeInTheDocument();
  });
});

describe('reminders', () => {
  it('adds, then toggles a reminder off', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Meds' });
    renderApp(test, `/trackers/${t.id}`);

    await screen.findByRole('heading', { name: 'Reminders' });
    await user.click(screen.getByRole('button', { name: /add reminder/i }));

    // "9:00 AM" reminder row appears with an On toggle.
    const toggle = await screen.findByRole('checkbox');
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument());

    const reminders = await test.core.reminders.forTracker(t.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.enabled).toBe(0);
  });
});

describe('groups', () => {
  it('creates a group and adds a tracker to it', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Pushups' });

    renderApp(test, '/groups');

    await user.type(await screen.findByLabelText('Group name'), 'Fitness');
    await user.click(screen.getByRole('button', { name: /add group/i }));

    // Group heading appears.
    expect(await screen.findByRole('heading', { name: 'Fitness' })).toBeInTheDocument();

    // Add the tracker via the group's select.
    const select = await screen.findByLabelText(/add tracker to fitness/i);
    await user.selectOptions(select, screen.getByRole('option', { name: 'Pushups' }));
    const card = (select.closest('.group-card') as HTMLElement) ?? document.body;
    await user.click(within(card).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(within(card).getByText('Pushups')).toBeInTheDocument(),
    );

    const groups = await test.core.groups.list();
    const members = await test.core.groups.trackersIn(groups[0]!.id);
    expect(members.map((m) => m.name)).toEqual(['Pushups']);
  });

  it('shows grouped trackers under their heading on home', async () => {
    const t = await test.createTracker({ name: 'Reading' });
    const g = await test.core.groups.create({ name: 'Habits', sort_order: 0 });
    await test.core.groups.addTracker(g.id, t.id);

    renderApp(test, '/');
    expect(await screen.findByText('Habits')).toBeInTheDocument();
    expect(await screen.findByText('Reading')).toBeInTheDocument();
  });
});

describe('compare page', () => {
  it('renders a comparison chart for trackers with data', async () => {
    const a = await test.createTracker({ name: 'Water', kind: 'number' });
    const b = await test.createTracker({ name: 'Coffee', kind: 'number' });
    await test.core.entries.log(a.id, { value: 3 });
    await test.core.entries.log(b.id, { value: 1 });

    renderApp(test, '/compare');

    // The picker lists both trackers (checkboxes), defaulted on.
    expect(await screen.findByText('Compare trackers')).toBeInTheDocument();
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThanOrEqual(2);

    // With both selected and data present, the comparison figure renders.
    expect(
      await screen.findByRole('img', { name: /tracker comparison over time/i }),
    ).toBeInTheDocument();
  });
});
