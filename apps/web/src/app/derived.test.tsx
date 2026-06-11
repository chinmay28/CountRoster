import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
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

/** Build Revenue (+150) and Expenses (+30) with a derived Profit tracker. */
async function profitFixture() {
  const revenue = await test.createTracker({ name: 'Revenue', kind: 'number' });
  const expenses = await test.createTracker({ name: 'Expenses', kind: 'number' });
  await test.core.entries.log(revenue.id, { value: 100 });
  await test.core.entries.log(revenue.id, { value: 50 });
  await test.core.entries.log(expenses.id, { value: 30 });
  const profit = await test.createTracker({
    name: 'Profit',
    kind: 'number',
    links: [
      { source_id: revenue.id, coefficient: 1 },
      { source_id: expenses.id, coefficient: -1 },
    ],
  });
  return { revenue, expenses, profit };
}

describe('derived tracker detail', () => {
  it('shows the computed total, the sources, and no log form', async () => {
    const { profit } = await profitFixture();
    renderApp(test, `/trackers/${profit.id}`);

    // Headline total is Revenue − Expenses = 150 − 30 = 120.
    expect(await screen.findByText('120')).toBeInTheDocument();

    // The derivation is spelled out with both source names.
    const derivation = screen.getByRole('heading', { name: /derived from/i });
    expect(derivation).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Revenue' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Expenses' })).toBeInTheDocument();

    // Derived trackers can't be logged directly.
    expect(screen.queryByRole('heading', { name: /^log an entry$/i })).toBeNull();
    expect(
      screen.getByRole('heading', { name: /contributing entries/i }),
    ).toBeInTheDocument();
  });
});

describe('derived tracker creation', () => {
  it('creates a derived tracker through the form', async () => {
    const revenue = await test.createTracker({ name: 'Revenue', kind: 'number' });
    const expenses = await test.createTracker({ name: 'Expenses', kind: 'number' });
    await test.core.entries.log(revenue.id, { value: 100 });
    await test.core.entries.log(expenses.id, { value: 30 });

    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Profit');
    await user.click(
      screen.getByLabelText(/derived tracker/i),
    );

    // Scope to the Sources fieldset (a `group`) so we don't grab the
    // "Reset every" select, which is also a combobox.
    const sources = () => within(screen.getByRole('group', { name: /sources/i }));

    // Add the first source (Revenue, coefficient defaults to 1).
    await user.click(screen.getByRole('button', { name: /add source/i }));
    const row1Select = sources().getAllByRole('combobox')[0]!;
    await user.selectOptions(row1Select, revenue.id);

    // Add a second source (Expenses, coefficient -1).
    await user.click(screen.getByRole('button', { name: /add source/i }));
    const row2Select = sources().getAllByRole('combobox')[1]!;
    await user.selectOptions(row2Select, expenses.id);
    const coeff2 = sources().getAllByLabelText('Coefficient')[1]!;
    await user.clear(coeff2);
    await user.type(coeff2, '-1');

    await user.click(screen.getByRole('button', { name: /create tracker/i }));

    // Lands on the new tracker's detail with the computed total (70) shown.
    expect(await screen.findByText('70')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /derived from/i })).toBeInTheDocument();

    // And it is persisted as a derived tracker with two links.
    await waitFor(async () => {
      const all = await test.core.trackers.list();
      const created = all.find((t) => t.name === 'Profit');
      expect(created?.is_derived).toBe(1);
    });
  });
});
