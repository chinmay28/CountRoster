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

    // Headline total is Revenue − Expenses = 150 − 30 = 120 (also echoed in the
    // all-time window of the breakdown).
    expect((await screen.findAllByText('120')).length).toBeGreaterThan(0);

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

describe('derived tracker composition', () => {
  it('shows a donut with per-source percentages for an additive derivation', async () => {
    const food = await test.createTracker({ name: 'Food', kind: 'number' });
    const drinks = await test.createTracker({ name: 'Drinks', kind: 'number' });
    await test.core.entries.log(food.id, { value: 300 });
    await test.core.entries.log(drinks.id, { value: 100 });
    const calories = await test.createTracker({
      name: 'Calories',
      kind: 'number',
      links: [
        { source_id: food.id, coefficient: 1 },
        { source_id: drinks.id, coefficient: 1 },
      ],
    });
    renderApp(test, `/trackers/${calories.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;
    // Legend carries each source with its share of the 400 total.
    expect(within(section).getByRole('link', { name: 'Food' })).toBeInTheDocument();
    expect(within(section).getByText(/300 · 75%/)).toBeInTheDocument();
    expect(within(section).getByText(/100 · 25%/)).toBeInTheDocument();
    // The donut itself, with an accessible summary.
    expect(
      within(section).getByRole('img', { name: /Food 75%.*Drinks 25%/ }),
    ).toBeInTheDocument();
  });

  it('splits the added total into subtractions and the net for a subtractive derivation', async () => {
    const { profit } = await profitFixture();
    renderApp(test, `/trackers/${profit.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;
    // Revenue (+150) is the whole here — a legend row with no share — and the
    // ring splits it into Expenses' cut (30 of 150 = 20%) and the net (80%).
    const revenueRow = within(section).getByRole('link', { name: 'Revenue' })
      .parentElement!;
    expect(revenueRow).toHaveTextContent(/^Revenue150$/);
    expect(within(section).getByText(/-30 · 20%/)).toBeInTheDocument();
    expect(within(section).getByText('Net')).toBeInTheDocument();
    expect(within(section).getByText(/120 · 80%/)).toBeInTheDocument();
    // The donut announces the split and centers on the whole (gross 150).
    const donut = within(section).getByRole('img', {
      name: /Expenses subtracts 20%.*net 80%/,
    });
    expect(donut).toHaveTextContent('150');
  });

  it('falls back to absolute movement when subtractions exceed the additions', async () => {
    const revenue = await test.createTracker({ name: 'Revenue', kind: 'number' });
    const expenses = await test.createTracker({ name: 'Expenses', kind: 'number' });
    await test.core.entries.log(revenue.id, { value: 150 });
    await test.core.entries.log(expenses.id, { value: 200 });
    const profit = await test.createTracker({
      name: 'Profit',
      kind: 'number',
      links: [
        { source_id: revenue.id, coefficient: 1 },
        { source_id: expenses.id, coefficient: -1 },
      ],
    });
    renderApp(test, `/trackers/${profit.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;
    // A negative net has no "whole" to split — each source is sized by its
    // absolute movement (150 vs 200 of 350: 43% / 57%) around the net (−50),
    // biggest mover first.
    expect(within(section).getByText(/150 · 43%/)).toBeInTheDocument();
    expect(within(section).getByText(/-200 · 57%/)).toBeInTheDocument();
    const donut = within(section).getByRole('img', {
      name: /Expenses subtracts 57%.*Revenue 43%/,
    });
    expect(donut).toHaveTextContent('-50');
  });

  it('scopes the composition to a reset window picked from the dropdown', async () => {
    const year = new Date().getFullYear();
    const food = await test.createTracker({ name: 'Food', kind: 'number' });
    const drinks = await test.createTracker({ name: 'Drinks', kind: 'number' });
    await test.core.entries.log(food.id, { value: 300 });
    await test.core.entries.log(drinks.id, { value: 100 });
    // A backdated entry in the previous calendar year.
    await test.core.entries.log(food.id, {
      value: 500,
      occurred_at: `${year - 1}-06-15T12:00:00.000-07:00`,
    });
    const calories = await test.createTracker({
      name: 'Calories',
      kind: 'number',
      reset_period: 'yearly',
      links: [
        { source_id: food.id, coefficient: 1 },
        { source_id: drinks.id, coefficient: 1 },
      ],
    });

    const user = userEvent.setup();
    renderApp(test, `/trackers/${calories.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;
    // All time is the default: Food 800 of 900 (89%), Drinks 100 (11%).
    expect(await within(section).findByText(/800 · 89%/)).toBeInTheDocument();

    const select = within(section).getByRole('combobox', { name: /period/i });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All time', 'This year', 'Last year']);

    // This year excludes the backdated 500: Food 300 (75%), Drinks 100 (25%).
    await user.selectOptions(select, within(select).getByRole('option', { name: 'This year' }));
    expect(await within(section).findByText(/300 · 75%/)).toBeInTheDocument();

    // Last year has only the backdated Food entry; Drinks stays as a 0% row.
    await user.selectOptions(select, within(select).getByRole('option', { name: 'Last year' }));
    expect(await within(section).findByText(/500 · 100%/)).toBeInTheDocument();
    expect(within(section).getByText(/0 · 0%/)).toBeInTheDocument();
  });

  it('orders the legend by share, highest first, regardless of link order', async () => {
    // Drinks is linked first but contributes the smaller share.
    const drinks = await test.createTracker({ name: 'Drinks', kind: 'number' });
    const food = await test.createTracker({ name: 'Food', kind: 'number' });
    await test.core.entries.log(drinks.id, { value: 100 });
    await test.core.entries.log(food.id, { value: 300 });
    const calories = await test.createTracker({
      name: 'Calories',
      kind: 'number',
      links: [
        { source_id: drinks.id, coefficient: 1 },
        { source_id: food.id, coefficient: 1 },
      ],
    });
    renderApp(test, `/trackers/${calories.id}`);

    const heading = await screen.findByRole('heading', { name: /composition/i });
    const section = heading.closest('section')!;
    await within(section).findByText(/300 · 75%/);
    const legend = [...section.querySelectorAll('.composition__item a')].map(
      (a) => a.textContent,
    );
    expect(legend).toEqual(['Food', 'Drinks']);
  });

  it('hides the composition section for a single-source derivation', async () => {
    const steps = await test.createTracker({ name: 'Steps', kind: 'number' });
    await test.core.entries.log(steps.id, { value: 4000 });
    const doubled = await test.createTracker({
      name: 'Doubled steps',
      kind: 'number',
      links: [{ source_id: steps.id, coefficient: 2 }],
    });
    renderApp(test, `/trackers/${doubled.id}`);

    // Wait for the page to settle, then confirm the section never appeared —
    // one operand has no breakdown to show.
    await screen.findByRole('heading', { name: /derived from/i });
    expect(screen.queryByRole('heading', { name: /composition/i })).toBeNull();
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
    expect((await screen.findAllByText('70')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /derived from/i })).toBeInTheDocument();

    // And it is persisted as a derived tracker with two links.
    await waitFor(async () => {
      const all = await test.core.trackers.list();
      const created = all.find((t) => t.name === 'Profit');
      expect(created?.is_derived).toBe(1);
    });
  });
});
