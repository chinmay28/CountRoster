import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { QuickLogPage } from '../pages/QuickLogPage.tsx';
import { datetimeInputLabel, fromDatetimeLocalValue } from '../lib/format.ts';
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
    const t = await test.createTracker({ name: 'Water', kind: 'count', reset_period: 'daily' });
    await test.core.entries.log(t.id, { value: 3 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    expect(await screen.findByText('Water')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText(/today/)).toBeInTheDocument();
  });

  /**
   * The pace comparison is read against the host wall clock, so these pin it.
   * Only `Date` is faked — the timers the page and userEvent rely on stay
   * real.
   */
  async function atFixedTime(local: string, body: (test: TestCore) => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(local));
    try {
      await body(await makeTestCore());
    } finally {
      vi.useRealTimers();
    }
  }

  it('sets the running total against the same point of the period before', async () => {
    await atFixedTime('2026-07-30T17:52:00', async (fixed) => {
      const t = await fixed.createTracker({
        name: 'Feeds',
        kind: 'number',
        unit: 'ml',
        reset_period: 'daily',
        target: 434,
      });
      const log = (value: number, when: string) =>
        fixed.core.entries.log(t.id, {
          value,
          occurred_at: fromDatetimeLocalValue(when),
        });
      // Yesterday had two feeds, one on either side of this hour: only the
      // earlier counts, because that's all yesterday had reached by now.
      await log(120, '2026-07-29T09:00');
      await log(500, '2026-07-29T20:00');
      await log(205, '2026-07-30T08:00');

      renderQuick(fixed, `/trackers/${t.id}/quick`);

      expect(await screen.findByText('205 ml')).toBeInTheDocument();
      expect(
        screen.getByText(/today · target 434 ml · 120 ml by now yesterday/),
      ).toBeInTheDocument();
    });
  });

  it('leaves the comparison off until there is a period to compare with', async () => {
    await atFixedTime('2026-07-30T17:52:00', async (fixed) => {
      const t = await fixed.createTracker({
        name: 'Feeds',
        kind: 'number',
        unit: 'ml',
        reset_period: 'daily',
      });
      await fixed.core.entries.log(t.id, {
        value: 205,
        occurred_at: fromDatetimeLocalValue('2026-07-30T08:00'),
      });
      renderQuick(fixed, `/trackers/${t.id}/quick`);

      await screen.findByText('Feeds');
      // A tracker whose first entry is today has never left zero; "0 ml by
      // now yesterday" would be noise dressed as a stat.
      expect(screen.queryByText(/by now yesterday/)).not.toBeInTheDocument();
    });
  });

  it('puts Details on the left and Home on the right', async () => {
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent('Details');
    expect(links[0]).toHaveAttribute('href', `/trackers/${t.id}`);
    expect(links[1]).toHaveTextContent('Home');
    expect(links[1]).toHaveAttribute('href', '/');
  });

  it('renders without the app shell, so nothing competes with the tap', async () => {
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New tracker' })).not.toBeInTheDocument();
  });

  it('logs a custom value with a note attached to that entry', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
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
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
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

describe('quick log — backdating', () => {
  /**
   * Open the picker and set a time. `fireEvent.change` rather than typing:
   * jsdom's datetime-local doesn't accept per-segment keystrokes.
   */
  async function pickWhen(user: ReturnType<typeof userEvent.setup>, value: string) {
    await user.click(await screen.findByRole('button', { name: 'Logging now' }));
    fireEvent.change(screen.getByLabelText('When'), { target: { value } });
  }

  /** A datetime-local value a couple of hours before now. */
  function hoursAgo(hours: number): string {
    const d = new Date(Date.now() - hours * 3_600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  it('logs a keypad amount at the time you pick', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(3);
    const t = await test.createTracker({ name: 'Feeds', kind: 'number', unit: 'ml' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: '6' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(60);
      // Stored with a local offset, at the chosen wall-clock time.
      expect(entries[0]!.occurred_at).not.toMatch(/Z$/);
      expect(new Date(entries[0]!.occurred_at).getHours()).toBe(
        new Date(when).getHours(),
      );
    });
  });

  it('names the time in the undo bar, so a backdate can’t apply silently', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(2);
    const t = await test.createTracker({ name: 'Feeds', kind: 'number' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    // Named the same way the field would name it — two hours ago is only
    // "Today" for a suite that doesn't run in the small hours.
    expect(
      await screen.findByText(`Logged 5 · ${datetimeInputLabel(when)}`),
    ).toBeInTheDocument();
  });

  it('backdates a one-tap count without opening the drawer', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(5);
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: 'Log 1' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(new Date(entries[0]!.occurred_at).getHours()).toBe(
        new Date(when).getHours(),
      );
    });
  });

  it('gives a note the same instant as the entry it describes', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(4);
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: 'Custom value' }));
    await user.type(screen.getByLabelText('Note'), 'left side');
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const notes = await test.core.notes.forTracker(t.id);
      expect(notes).toHaveLength(1);
      expect(new Date(notes[0]!.occurred_at).getHours()).toBe(
        new Date(when).getHours(),
      );
    });
  });

  it('keeps the chosen time across entries, instead of resetting on each log', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(3);
    const t = await test.createTracker({ name: 'Feeds', kind: 'number' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));
    await waitFor(async () => {
      expect(await test.core.entries.forTracker(t.id)).toHaveLength(1);
    });

    // The refresh after a log must not remount the panel — that would drop
    // the chosen time (and a half-typed note) on the floor.
    expect(screen.getByLabelText('When')).toHaveValue(when);

    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: 'Log entry' }));
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(new Date(entry.occurred_at).getHours()).toBe(new Date(when).getHours());
      }
    });
  });

  it('opens the picker in place of the chip, without growing a second row', async () => {
    const user = userEvent.setup();
    const t = await test.createTracker({ name: 'Feeds', kind: 'number' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Logging now' }));

    // The chip is gone rather than sitting above the picker: a row appearing
    // here would push the log button down, out from under the thumb.
    expect(screen.queryByRole('button', { name: 'Logging now' })).not.toBeInTheDocument();
    const row = screen.getByLabelText('When').parentElement!;
    expect(row.children).toHaveLength(2); // the picker and its ✕
    expect(row.querySelector('.quick__when-input')).toBe(screen.getByLabelText('When'));
  });

  it('goes back to now on request', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(2);
    const t = await test.createTracker({ name: 'Water', kind: 'count' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    // The picker holds the chosen time, and shows it's no longer "now".
    expect(screen.getByLabelText('When')).toHaveValue(when);
    expect(screen.getByLabelText('When')).toHaveClass('quick__when-input--accent');

    await user.click(screen.getByRole('button', { name: 'Back to now' }));
    expect(screen.getByRole('button', { name: 'Logging now' })).toBeInTheDocument();
    expect(screen.queryByLabelText('When')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log 1' }));
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      // Logged at the current instant: within a minute of now.
      expect(Date.now() - new Date(entries[0]!.occurred_at).getTime()).toBeLessThan(60_000);
    });
  });

  it('backdates a snapshot reading', async () => {
    const user = userEvent.setup();
    const when = hoursAgo(20);
    const t = await test.createTracker({ name: 'Weight', is_snapshot: 1, default_value: 0.2 });
    const seeded = await test.core.entries.log(t.id, { value: 179.2 });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await pickWhen(user, when);
    await user.click(screen.getByRole('button', { name: 'Log reading' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(2);
      // Entries come back oldest-first, so a backdated reading sorts ahead of
      // the seeded one — find it by id, not by position.
      const logged = entries.find((e) => e.id !== seeded.id);
      expect(new Date(logged!.occurred_at).getHours()).toBe(new Date(when).getHours());
    });
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

  it('never restores a tracker manifest, even when the server pre-set one', async () => {
    // What a fresh (non-iOS) load of the quick URL looks like: the server
    // already served the document with a per-tracker manifest link, so the
    // href this effect finds is NOT the app's own manifest.
    const head = seedHead();
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    link.setAttribute('href', '/trackers/stale/app.webmanifest');

    const t = await test.createTracker({ name: 'Water' });
    const { unmount } = renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    expect(head.manifest()).toBe(`/trackers/${t.id}/app.webmanifest`);

    // Navigating away must hand back the *app's* manifest — parking the
    // pre-set tracker href would pin this tracker onto every other page.
    unmount();
    expect(head.manifest()).toBe('/manifest.webmanifest');
  });

  it('leaves an iOS-style manifest-less document alone', async () => {
    // The server serves quick pages to iOS with no manifest link at all;
    // the effect must not conjure one back.
    document.head.innerHTML =
      '<meta name="theme-color" content="#1f2933">' +
      '<meta name="apple-mobile-web-app-title" content="CountRoster">';

    const t = await test.createTracker({ name: 'Water' });
    renderQuick(test, `/trackers/${t.id}/quick`);

    await screen.findByText('Water');
    expect(document.querySelector('link[rel="manifest"]')).toBeNull();
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
