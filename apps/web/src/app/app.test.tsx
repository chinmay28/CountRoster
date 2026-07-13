import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  RouterProvider,
} from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from '../pages/TrackerFormPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
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
          { path: 'trackers/:id/edit', element: <TrackerFormPage /> },
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

describe('HomePage', () => {
  it('shows the empty state when there are no trackers', async () => {
    renderApp(test);
    expect(await screen.findByText('No trackers yet')).toBeInTheDocument();
  });

  it('lists active trackers with today totals', async () => {
    const t = await test.createTracker({ name: 'Water' });
    await test.core.entries.log(t.id, { value: 3 });
    renderApp(test);
    expect(await screen.findByText('Water')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
  });
});

describe('mobile tab bar', () => {
  it('renders the bottom navigation and marks the current route active', async () => {
    renderApp(test);

    const tabBar = document.querySelector('.tab-bar') as HTMLElement;
    expect(tabBar).toBeInTheDocument();
    // All four primary destinations are present as tabs.
    for (const label of ['Home', 'Transactions', 'Groups', 'Data']) {
      expect(within(tabBar).getByText(label)).toBeInTheDocument();
    }
    // On "/", the Home tab is the active one.
    const home = within(tabBar).getByText('Home').closest('a')!;
    expect(home.className).toContain('tab-bar__item--active');
  });
});

describe('quick log', () => {
  it('logs the default value when the value field is left blank', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Pushups', default_value: 5 });
    renderApp(test);

    await screen.findByText('Pushups');
    const card = screen.getByText('Pushups').closest('.tracker-card')! as HTMLElement;
    // Open the log panel, then submit without typing a value (uses the default).
    await user.click(within(card).getByRole('button', { name: /log pushups/i }));
    await user.click(within(card).getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(within(card).getByText('5')).toBeInTheDocument());
  });
});

describe('create tracker flow', () => {
  it('creates a tracker and navigates to its detail page', async () => {
    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Coffee');
    await user.click(screen.getByRole('button', { name: /create tracker/i }));

    expect(await screen.findByRole('heading', { name: 'Coffee' })).toBeInTheDocument();
    const trackers = await test.core.trackers.list();
    expect(trackers.map((t) => t.name)).toContain('Coffee');
  });
});

describe('entry pagination and search', () => {
  it('shows 10 entries per page, newest first, with a pager', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Sips', kind: 'number' });
    // 12 entries at distinct instants so newest-first order is unambiguous.
    for (let i = 1; i <= 12; i++) {
      await test.core.entries.log(t.id, {
        value: i,
        occurred_at: `2026-05-${String(i).padStart(2, '0')}T10:00:00.000-07:00`,
      });
    }

    renderApp(test, `/trackers/${t.id}`);

    // Page 1 holds the 10 newest (values 12..3); the 2 oldest wait on page 2.
    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument();
    const list = () => document.querySelectorAll('.entry-list .entry');
    await waitFor(() => expect(list()).toHaveLength(10));
    const firstPage = [...list()].map((el) => el.querySelector('.entry__value')!.textContent);
    expect(firstPage[0]).toBe('12');
    expect(firstPage).not.toContain('2');

    // "Newer" is disabled on the first page; "Older" moves to the last two.
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(list()).toHaveLength(2));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    const lastPage = [...list()].map((el) => el.querySelector('.entry__value')!.textContent);
    expect(lastPage).toEqual(['2', '1']);
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled();
  });

  it('filters entries by their linked note text', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Spend', kind: 'number' });
    for (let i = 1; i <= 11; i++) {
      const entry = await test.core.entries.log(t.id, {
        value: i,
        occurred_at: `2026-05-${String(i).padStart(2, '0')}T10:00:00.000-07:00`,
      });
      if (i === 2) {
        await test.core.notes.create({
          tracker_id: t.id,
          entry_id: entry.id,
          body: 'Groceries at the market',
        });
      }
    }

    renderApp(test, `/trackers/${t.id}`);
    await screen.findByText('Page 1 of 2');

    // Searching by the note surfaces only its entry — even from page 2.
    await user.type(
      screen.getByRole('searchbox', { name: /search entries by note/i }),
      'groceries',
    );
    const list = () => document.querySelectorAll('.entry-list .entry');
    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0]!.querySelector('.entry__value')!.textContent).toBe('2');
    expect(screen.getByText('Groceries at the market')).toBeInTheDocument();
    // A single page of results needs no pager.
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();

    // A query with no matching note shows the empty-search state.
    await user.clear(screen.getByRole('searchbox', { name: /search entries by note/i }));
    await user.type(
      screen.getByRole('searchbox', { name: /search entries by note/i }),
      'zzz',
    );
    expect(await screen.findByText(/No entries match/)).toBeInTheDocument();
  });
});

describe('note editing with history', () => {
  it('edits a note and exposes the previous version in history', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Mood' });
    await test.core.notes.create({ tracker_id: t.id, body: 'Felt off today.' });

    renderApp(test, `/trackers/${t.id}`);

    expect(await screen.findByText('Felt off today.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByDisplayValue('Felt off today.');
    await user.clear(textarea);
    await user.type(textarea, 'Felt better after a walk.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Felt better after a walk.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('Felt off today.')).toBeInTheDocument();
  });
});
