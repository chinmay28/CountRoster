import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { QuickLogPage } from '../pages/QuickLogPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

/**
 * The quick screen is registered the way main.tsx registers it: a top-level
 * route *outside* the app shell, so these tests also pin that it renders
 * without the header and tab bar.
 */
function renderQuick(test: TestCore, path: string) {
  const router = createMemoryRouter(
    [
      { path: '/trackers/:id/quick', element: <QuickLogPage /> },
      {
        path: '/',
        element: <AppLayout />,
        children: [{ path: 'trackers/:id', element: <TrackerDetailPage /> }],
      },
    ],
    { initialEntries: [path] },
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

describe('quick log — one tap (count)', () => {
  it('logs the default value on a single tap and offers undo', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Water', kind: 'count', default_value: 1 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Log 1' }));

    await waitFor(async () => {
      expect(await test.core.entries.forTracker(t.id)).toHaveLength(1);
    });
    expect(await screen.findByText('Logged 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => {
      expect(await test.core.entries.forTracker(t.id)).toHaveLength(0);
    });
  });

  it('shows the running total for the reset window', async () => {
    const t = await test.createTracker({ name: 'Water', reset_period: 'daily' });
    await test.core.entries.log(t.id, { value: 3 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    expect(await screen.findByText('Water')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText(/today/)).toBeInTheDocument();
  });

  it('renders without the app shell, so nothing competes with the tap', async () => {
    const t = await test.createTracker({ name: 'Water' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New tracker' })).not.toBeInTheDocument();
  });

  it('logs a custom value with a note attached to that entry', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Water' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Custom value' }));
    await user.type(screen.getByLabelText('Value'), '4');
    await user.type(screen.getByLabelText('Note'), 'big glass');
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(4);
    });
    const notes = await test.core.notes.forTracker(t.id);
    expect(notes[0]!.body).toBe('big glass');
    expect(notes[0]!.entry_id).toBe((await test.core.entries.forTracker(t.id))[0]!.id);
  });

  it('undoing an entry logged with a note removes the note too', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Water' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Custom value' }));
    await user.type(screen.getByLabelText('Note'), 'oops');
    await user.click(screen.getByRole('button', { name: 'Log entry' }));
    await screen.findByRole('button', { name: 'Undo' });

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => {
      expect(await test.core.entries.forTracker(t.id)).toHaveLength(0);
      expect(await test.core.notes.forTracker(t.id)).toHaveLength(0);
    });
  });
});

describe('quick log — yes / no', () => {
  it('offers both answers and logs the one tapped', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Took meds', kind: 'boolean' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'No' }));
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(0);
    });
  });
});

describe('quick log — keypad (number)', () => {
  it('enters an amount on the keypad and logs it', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Spending', kind: 'number', unit: '$' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: '1' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'Decimal point' }));
    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(12.5);
    });
  });

  it('deletes the last digit', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Spending', kind: 'number' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: '4' }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'Delete last digit' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      expect((await test.core.entries.forTracker(t.id))[0]!.value).toBe(4);
    });
  });

  it('offers the amounts this tracker is actually logged with, and logs one on tap', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Spending', kind: 'number', default_value: 1 });
    for (const value of [7, 7, 7, 20]) await test.core.entries.log(t.id, { value });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Log 7' }));
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(5);
      expect(entries[4]!.value).toBe(7);
    });
  });

  it('cannot log an empty amount', async () => {
    const t = await test.createTracker({ name: 'Spending', kind: 'number' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    expect(await screen.findByRole('button', { name: 'Log entry' })).toBeDisabled();
  });
});

describe('quick log — stepper (snapshot)', () => {
  it('starts from the last reading and steps by the default value', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({
      name: 'Weight',
      kind: 'number',
      unit: 'lb',
      is_snapshot: 1,
      default_value: 0.2,
    });
    await test.core.entries.log(t.id, { value: 179.2 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    expect(await screen.findByRole('button', { name: /Reading 179\.2 lb/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Decrease by 0.2' }));
    await user.click(screen.getByRole('button', { name: 'Log reading' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(2);
      // 179.2 - 0.2 in plain floating point is 178.99999999999997.
      expect(entries[1]!.value).toBe(179);
    });
  });

  it('accepts a typed reading', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Weight', is_snapshot: 1, default_value: 0.2 });
    await test.core.entries.log(t.id, { value: 179.2 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: /Reading/ }));
    const input = screen.getByLabelText('Reading');
    await user.clear(input);
    await user.type(input, '176.4');
    await user.click(screen.getByRole('button', { name: 'Log reading' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries[entries.length - 1]!.value).toBe(176.4);
    });
  });
});

describe('quick log — trackers with nothing to log', () => {
  it('explains that a derived tracker has no entries of its own', async () => {
    const source = await test.createTracker({ name: 'Revenue' });
    const derived = await test.createTracker({ name: 'Profit', is_derived: 1 });
    await test.core.trackers.setLinks(derived.id, [
      { source_id: source.id, coefficient: 1 },
    ]);
    renderQuick(test, `/trackers/${derived.id}/quick`);

    expect(await screen.findByText(/computed from others/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Log/ })).not.toBeInTheDocument();
  });

  it('shows a dead-end message for a stale bookmark', async () => {
    renderQuick(test, '/trackers/does-not-exist/quick');
    expect(await screen.findByText('Tracker not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open CountRoster' })).toBeInTheDocument();
  });

  it('still opens for a hidden tracker, since its URL is the bookmark', async () => {
    const t = await test.createTracker({ name: 'Private', is_hidden: 1 });
    renderQuick(test, `/trackers/${t.id}/quick`);
    expect(await screen.findByText('Private')).toBeInTheDocument();
  });
});

describe('quick log — installing it to the Home Screen', () => {
  /** The head tags index.html ships, which the screen swaps while it's up. */
  function seedHead() {
    document.head.innerHTML =
      '<link rel="manifest" href="/manifest.webmanifest">' +
      '<meta name="theme-color" content="#1f2933">' +
      '<meta name="apple-mobile-web-app-title" content="CountRoster">';
    return {
      manifest: () => document.querySelector('link[rel="manifest"]')!.getAttribute('href'),
      title: () =>
        document
          .querySelector('meta[name="apple-mobile-web-app-title"]')!
          .getAttribute('content'),
      themeColor: () =>
        document.querySelector('meta[name="theme-color"]')!.getAttribute('content'),
    };
  }

  it('points the manifest at this tracker, so the icon opens this screen', async () => {
    const head = seedHead();
    const t = await test.createTracker({ name: 'Water', color: '#ff6b6b' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    // Without this the browser installs the app manifest's start_url ("/")
    // and the Home Screen icon opens the app's home screen instead.
    expect(head.manifest()).toBe(`/trackers/${t.id}/app.webmanifest`);
    expect(head.title()).toBe('Water');
    expect(head.themeColor()).toBe('#ff6b6b');
  });

  it('restores the app manifest index.html parked, not the tracker’s', async () => {
    // What a fresh load of the quick URL looks like: the inline script in
    // index.html has already swapped the link and stashed the original.
    const head = seedHead();
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    link.dataset.appManifest = '/manifest.webmanifest';
    link.setAttribute('href', '/trackers/stale/app.webmanifest');

    const t = await test.createTracker({ name: 'Water' });
    const { unmount } = renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    expect(head.manifest()).toBe(`/trackers/${t.id}/app.webmanifest`);

    unmount();
    expect(head.manifest()).toBe('/manifest.webmanifest');
  });

  it('restores the app’s own manifest on the way out', async () => {
    const head = seedHead();
    const t = await test.createTracker({ name: 'Water', color: '#ff6b6b' });
    const { unmount } = renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    unmount();

    expect(head.manifest()).toBe('/manifest.webmanifest');
    expect(head.title()).toBe('CountRoster');
    expect(head.themeColor()).toBe('#1f2933');
  });
});

describe('detail page', () => {
  it('links to the tracker’s quick screen', async () => {
    const t = await test.createTracker({ name: 'Water' });
    renderQuick(test, `/trackers/${t.id}`);

    const link = await screen.findByRole('link', { name: 'Quick log' });
    expect(link).toHaveAttribute('href', `/trackers/${t.id}/quick`);
  });

  it('offers no quick screen for a derived tracker', async () => {
    const source = await test.createTracker({ name: 'Revenue' });
    const derived = await test.createTracker({ name: 'Profit', is_derived: 1 });
    await test.core.trackers.setLinks(derived.id, [
      { source_id: source.id, coefficient: 1 },
    ]);
    renderQuick(test, `/trackers/${derived.id}`);

    await screen.findByText('Profit');
    expect(screen.queryByRole('link', { name: 'Quick log' })).not.toBeInTheDocument();
  });
});
