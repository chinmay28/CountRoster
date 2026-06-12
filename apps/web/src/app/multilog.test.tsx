import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { toDateInputValue, shiftDateInputValue } from '../lib/format.ts';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderDetail(test: TestCore, trackerId: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [{ path: 'trackers/:id', element: <TrackerDetailPage /> }],
      },
    ],
    { initialEntries: [`/trackers/${trackerId}`] },
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

/** Open the tracker detail page and switch to the "Log multiple" tab. */
async function openMultiTab(test: TestCore, trackerId: string) {
  const user = userEvent.setup();
  renderDetail(test, trackerId);
  await user.click(await screen.findByRole('tab', { name: /log multiple/i }));
  return user;
}

describe('Log multiple tab', () => {
  it('sits next to the single-entry form and shows the batch sheet', async () => {
    const t = await test.createTracker({ name: 'Coffee', unit: 'cups' });
    const user = userEvent.setup();
    renderDetail(test, t.id);

    // The single-entry form is the default tab.
    const singleTab = await screen.findByRole('tab', { name: /log an entry/i });
    expect(singleTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Log entry' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /log multiple/i }));
    expect(screen.getByRole('spinbutton', { name: /entry 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    // Switching back restores the detailed form.
    await user.click(screen.getByRole('tab', { name: /log an entry/i }));
    expect(screen.getByRole('button', { name: 'Log entry' })).toBeInTheDocument();
  });

  it('Enter on a filled last row grows the sheet and focuses the new row', async () => {
    const t = await test.createTracker({ name: 'Coffee' });
    const user = await openMultiTab(test, t.id);

    await user.click(screen.getByRole('spinbutton', { name: /entry 1/i }));
    await user.keyboard('3{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: /entry 2/i })).toHaveFocus(),
    );
    // Enter on the new, blank last row does NOT add a third — it's "done".
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('spinbutton', { name: /entry 3/i })).not.toBeInTheDocument();
  });

  it('logs all filled rows as one batch and resets the sheet', async () => {
    const t = await test.createTracker({ name: 'Coffee' });
    const user = await openMultiTab(test, t.id);

    await user.click(screen.getByRole('spinbutton', { name: /entry 1/i }));
    await user.keyboard('1{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: /entry 2/i })).toHaveFocus(),
    );
    await user.keyboard('2.5{Enter}');
    // Third row spawned but left blank — skipped, so the batch is two entries.
    await user.click(screen.getByRole('button', { name: /log 2 entries/i }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries.map((e) => e.value).sort()).toEqual([1, 2.5]);
    });
    expect(screen.getByText(/logged 2 entries/i)).toBeInTheDocument();
    // The sheet collapses back to a single empty row for the next round.
    expect(screen.getByRole('spinbutton', { name: /entry 1/i })).toHaveValue(null);
    expect(screen.queryByRole('spinbutton', { name: /entry 2/i })).not.toBeInTheDocument();
  });

  it('backdates the whole batch to noon of the pinned day', async () => {
    const t = await test.createTracker({ name: 'Coffee' });
    const user = await openMultiTab(test, t.id);

    await user.click(screen.getByRole('button', { name: 'Yesterday' }));
    await user.type(screen.getByRole('spinbutton', { name: /entry 1/i }), '1');
    await user.click(screen.getByRole('button', { name: /log 1 entry/i }));

    const yesterday = shiftDateInputValue(toDateInputValue(), -1);
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(t.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.occurred_at.startsWith(`${yesterday}T12:00`)).toBe(true);
    });
  });

  it('rows can be added with the button and removed again', async () => {
    const t = await test.createTracker({ name: 'Coffee' });
    const user = await openMultiTab(test, t.id);

    // A lone row has no remove button — there must always be one row.
    expect(screen.queryByRole('button', { name: /remove entry/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add a row/i }));
    expect(screen.getByRole('spinbutton', { name: /entry 2/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove entry 2/i }));
    expect(screen.queryByRole('spinbutton', { name: /entry 2/i })).not.toBeInTheDocument();
  });

  it('does not offer logging tabs on a derived tracker', async () => {
    const source = await test.createTracker({ name: 'Source' });
    const derived = await test.createTracker({
      name: 'Net',
      links: [{ source_id: source.id, coefficient: 1 }],
    });

    renderDetail(test, derived.id);

    await screen.findByRole('heading', { name: 'Net' });
    expect(screen.queryByRole('tab', { name: /log multiple/i })).not.toBeInTheDocument();
  });
});
