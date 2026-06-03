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

describe('quick log', () => {
  it('increments today total by the default value', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Pushups', default_value: 5 });
    renderApp(test);

    await screen.findByText('Pushups');
    const card = screen.getByText('Pushups').closest('.tracker-card')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: /log pushups/i }));

    await waitFor(() =>
      expect(within(card as HTMLElement).getByText('5')).toBeInTheDocument(),
    );
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
