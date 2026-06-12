import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { MultiLogPage } from '../pages/MultiLogPage.tsx';
import { toDateInputValue, shiftDateInputValue } from '../lib/format.ts';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderMultiLog(test: TestCore) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [{ path: 'log', element: <MultiLogPage /> }],
      },
    ],
    { initialEntries: ['/log'] },
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

describe('MultiLogPage', () => {
  it('shows a value row per loggable tracker, excluding derived ones', async () => {
    await test.createTracker({ name: 'Coffee' });
    const water = await test.createTracker({ name: 'Water', unit: 'cups' });
    await test.createTracker({
      name: 'Net',
      links: [{ source_id: water.id, coefficient: 1 }],
    });

    renderMultiLog(test);

    expect(await screen.findByRole('spinbutton', { name: /coffee/i })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /water/i })).toBeInTheDocument();
    // The derived tracker has no input row (only ordinary trackers do).
    expect(screen.queryByRole('spinbutton', { name: /^net/i })).not.toBeInTheDocument();
  });

  it('logs only the filled rows in one batch and clears the sheet', async () => {
    const user = userEvent.setup();
    const coffee = await test.createTracker({ name: 'Coffee' });
    const water = await test.createTracker({ name: 'Water' });
    const meds = await test.createTracker({ name: 'Meds' });

    renderMultiLog(test);

    await user.type(await screen.findByRole('spinbutton', { name: /coffee/i }), '3');
    await user.type(screen.getByRole('spinbutton', { name: /water/i }), '2.5');
    // Meds left blank — skipped, not logged with a default.
    await user.click(screen.getByRole('button', { name: /log 2 entries/i }));

    await waitFor(async () => {
      expect(await test.core.entries.forTracker(coffee.id)).toHaveLength(1);
    });
    expect((await test.core.entries.forTracker(coffee.id))[0]!.value).toBe(3);
    expect((await test.core.entries.forTracker(water.id))[0]!.value).toBe(2.5);
    expect(await test.core.entries.forTracker(meds.id)).toHaveLength(0);

    // The sheet resets for the next round.
    expect(screen.getByRole('spinbutton', { name: /coffee/i })).toHaveValue(null);
    expect(screen.getByText(/logged 2 entries/i)).toBeInTheDocument();
  });

  it('backdates entries to noon of the pinned day', async () => {
    const user = userEvent.setup();
    const coffee = await test.createTracker({ name: 'Coffee' });

    renderMultiLog(test);

    await user.click(await screen.findByRole('button', { name: 'Yesterday' }));
    await user.type(screen.getByRole('spinbutton', { name: /coffee/i }), '1');
    await user.click(screen.getByRole('button', { name: /log 1 entry/i }));

    const yesterday = shiftDateInputValue(toDateInputValue(), -1);
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(coffee.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.occurred_at.startsWith(`${yesterday}T12:00`)).toBe(true);
    });
  });

  it('Enter advances focus to the next tracker row', async () => {
    const user = userEvent.setup();
    await test.createTracker({ name: 'Coffee' });
    await test.createTracker({ name: 'Water' });

    renderMultiLog(test);

    const coffee = await screen.findByRole('spinbutton', { name: /coffee/i });
    await user.click(coffee);
    await user.keyboard('3{Enter}');

    expect(screen.getByRole('spinbutton', { name: /water/i })).toHaveFocus();
  });

  it('"+" duplicates a row so the same tracker can be logged twice', async () => {
    const user = userEvent.setup();
    const coffee = await test.createTracker({ name: 'Coffee' });

    renderMultiLog(test);

    await user.click(
      await screen.findByRole('button', { name: /add another coffee entry/i }),
    );
    const inputs = screen.getAllByRole('spinbutton', { name: /coffee/i });
    expect(inputs).toHaveLength(2);

    await user.type(inputs[0]!, '1');
    await user.type(inputs[1]!, '2');
    await user.click(screen.getByRole('button', { name: /log 2 entries/i }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(coffee.id);
      expect(entries.map((e) => e.value).sort()).toEqual([1, 2]);
    });
    // Extra rows collapse after a successful submit.
    expect(screen.getAllByRole('spinbutton', { name: /coffee/i })).toHaveLength(1);
  });
});
