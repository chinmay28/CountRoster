import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { TransactionsPage } from '../pages/TransactionsPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderApp(test: TestCore, initialPath = '/transactions') {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { path: 'transactions', element: <TransactionsPage /> },
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

describe('transactions inbox', () => {
  it('shows the empty state with import hint', async () => {
    renderApp(test);
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
    expect(screen.getByLabelText(/import transactions csv/i)).toBeInTheDocument();
  });

  it('imports a CSV file, reporting new and duplicate rows', async () => {
    const user = userEvent.setup();
    renderApp(test);

    const csv = [
      'Date,Account,Description,Category,Tags,Amount',
      "2026-07-01,Amex,TRADER JOE'S #552,Groceries,,-43.21",
      '2026-07-02,Amex,SQ *BLUE BOTTLE,Restaurants,,-5.50',
    ].join('\n');
    const file = new File([csv], 'transactions.csv', { type: 'text/csv' });

    await user.upload(screen.getByLabelText(/import transactions csv/i), file);

    expect(await screen.findByText(/imported 2 new/i)).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Trader Joe's")).toBeInTheDocument();
    expect(screen.getByDisplayValue('Blue Bottle')).toBeInTheDocument();

    // Same file again → all duplicates.
    await user.upload(screen.getByLabelText(/import transactions csv/i), file);
    expect(
      await screen.findByText(/imported 0 new, skipped 2 already imported/i),
    ).toBeInTheDocument();
  });

  it('lists pending rows with suggestions, files one, and moves it to Filed', async () => {
    const user = userEvent.setup();
    const groceries = await test.createTracker({ name: 'Groceries', unit: '$' });
    await test.core.transactions.import({
      transactions: [
        {
          date: '2026-07-01',
          description: "TRADER JOE'S #552",
          amount: -43.21,
          category: 'Groceries',
        },
      ],
    });

    renderApp(test);

    // The suggestion is pre-selected in the tracker dropdown.
    const select = (await screen.findByLabelText(
      /tracker for TRADER JOE'S/i,
    )) as HTMLSelectElement;
    expect(select.value).toBe(groceries.id);

    await user.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(/filed .*trader joe/i)).toBeInTheDocument();
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();

    // The entry landed in the tracker with the note carrying the name.
    const entries = await test.core.entries.forTracker(groceries.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.value).toBe(43.21);
    const notes = await test.core.notes.forTracker(groceries.id);
    expect(notes[0]!.body).toBe("Trader Joe's");

    // The Filed filter shows it.
    await user.click(screen.getByRole('button', { name: 'Filed' }));
    expect(await screen.findByText(/filed into groceries/i)).toBeInTheDocument();
  });

  it('renames a transaction; the edited name becomes the note', async () => {
    const user = userEvent.setup();
    const groceries = await test.createTracker({ name: 'Groceries' });
    await test.core.transactions.import({
      transactions: [
        { date: '2026-07-01', description: 'WM SUPERCENTER', amount: -60, category: 'Groceries' },
      ],
    });

    renderApp(test);

    const name = await screen.findByLabelText(/name for WM SUPERCENTER/i);
    await user.clear(name);
    await user.type(name, 'Walmart');
    await user.tab(); // blur commits the rename

    await waitFor(async () => {
      const [txn] = await test.core.transactions.list();
      expect(txn!.name).toBe('Walmart');
    });

    await user.click(screen.getByRole('button', { name: 'File it' }));
    await waitFor(async () => {
      const notes = await test.core.notes.forTracker(groceries.id);
      expect(notes[0]!.body).toBe('Walmart');
    });
  });

  it('dismisses a transaction into the Dismissed filter', async () => {
    const user = userEvent.setup();
    await test.core.transactions.import({
      transactions: [{ date: '2026-07-01', description: 'SPAM', amount: -3 }],
    });

    renderApp(test);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismissed' }));
    const list = document.querySelector('.txn__list') as HTMLElement;
    expect(await within(list).findByText('Spam')).toBeInTheDocument();
    expect(within(list).getByText('Dismissed')).toBeInTheDocument();
  });

  it('files all categorized rows in bulk', async () => {
    const user = userEvent.setup();
    const groceries = await test.createTracker({ name: 'Groceries' });
    await test.core.transactions.import({
      transactions: [
        { date: '2026-07-01', description: 'A MART', amount: -1, category: 'Groceries' },
        { date: '2026-07-02', description: 'B MART', amount: -2, category: 'Groceries' },
        { date: '2026-07-03', description: 'MYSTERY', amount: -9 },
      ],
    });

    renderApp(test);
    await user.click(
      await screen.findByRole('button', { name: /file all 2 categorized/i }),
    );

    expect(await screen.findByText(/filed 2 transactions/i)).toBeInTheDocument();
    // The uncategorized one stays in the inbox.
    expect(await screen.findByDisplayValue('Mystery')).toBeInTheDocument();
    expect(await test.core.entries.forTracker(groceries.id)).toHaveLength(2);
  });
});
