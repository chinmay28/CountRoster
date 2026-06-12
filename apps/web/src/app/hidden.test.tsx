import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerFormPage } from '../pages/TrackerFormPage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { unlockTapCount } from './HiddenMode.tsx';
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

/** Tap the header brand (logo + word) `times` times. */
async function tapBrand(user: ReturnType<typeof userEvent.setup>, times: number) {
  const brand = screen.getByRole('link', { name: /countroster/i });
  for (let i = 0; i < times; i++) await user.click(brand);
}

const UNLOCK_TAPS = unlockTapCount(new Date().getFullYear());

let test: TestCore;
beforeEach(async () => {
  test = await makeTestCore();
});

describe('unlockTapCount', () => {
  it('is the digit sum of the year', () => {
    expect(unlockTapCount(2026)).toBe(10);
    expect(unlockTapCount(2030)).toBe(5);
    expect(unlockTapCount(1999)).toBe(28);
  });
});

describe('hidden tracker mode', () => {
  it('hides hidden trackers until the brand is tapped enough times', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Visible habit' });
    await test.createTracker({ name: 'Secret habit', is_hidden: 1 });
    renderApp(test);

    expect(await screen.findByText('Visible habit')).toBeInTheDocument();
    expect(screen.queryByText('Secret habit')).not.toBeInTheDocument();

    // One tap short does nothing.
    await tapBrand(user, UNLOCK_TAPS - 1);
    expect(screen.queryByText('Secret habit')).not.toBeInTheDocument();

    await tapBrand(user, 1);
    expect(await screen.findByText('Secret habit')).toBeInTheDocument();
    // The header shows the unlocked indicator.
    expect(screen.getByLabelText('Hidden trackers visible')).toBeInTheDocument();
  });

  it('relocks after 3 more taps', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Secret habit', is_hidden: 1 });
    renderApp(test);

    await tapBrand(user, UNLOCK_TAPS);
    expect(await screen.findByText('Secret habit')).toBeInTheDocument();

    await tapBrand(user, 3);
    await waitFor(() =>
      expect(screen.queryByText('Secret habit')).not.toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Hidden trackers visible')).not.toBeInTheDocument();
  });

  it('only offers the hidden checkbox on the form while unlocked', async () => {
    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await screen.findByLabelText('Name');
    expect(
      screen.queryByRole('checkbox', { name: /hidden tracker/i }),
    ).not.toBeInTheDocument();

    await tapBrand(user, UNLOCK_TAPS);
    // Tapping the brand navigates home; go back to the form (the header nav
    // and the floating action button both link there — either works).
    await user.click(screen.getAllByRole('link', { name: 'New tracker' })[0]!);

    await user.type(await screen.findByLabelText('Name'), 'Covert');
    await user.click(screen.getByRole('checkbox', { name: /hidden tracker/i }));
    await user.click(screen.getByRole('button', { name: /create tracker/i }));

    expect(await screen.findByRole('heading', { name: 'Covert' })).toBeInTheDocument();
    const all = await test.core.trackers.list({ includeHidden: true });
    expect(all.find((t) => t.name === 'Covert')?.is_hidden).toBe(1);
  });

  it('treats a hidden tracker URL as not found while locked', async () => {
    const t = await test.createTracker({ name: 'Secret habit', is_hidden: 1 });
    renderApp(test, `/trackers/${t.id}`);
    expect(await screen.findByText('Tracker not found')).toBeInTheDocument();
  });
});
