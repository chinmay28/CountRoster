import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { CoreValueProvider } from './CoreContext.tsx';
import { AppLayout } from './AppLayout.tsx';
import { HomePage } from '../pages/HomePage.tsx';
import { TrackerDetailPage } from '../pages/TrackerDetailPage.tsx';
import { TrackerFormPage } from '../pages/TrackerFormPage.tsx';
import { QuickLogPage } from '../pages/QuickLogPage.tsx';
import { makeTestCore, type TestCore } from '../test/makeTestCore.ts';

function renderApp(test: TestCore, initialPath = '/') {
  const router = createMemoryRouter(
    [
      { path: '/trackers/:id/quick', element: <QuickLogPage /> },
      {
        path: '/',
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'trackers/new', element: <TrackerFormPage /> },
          { path: 'trackers/:id', element: <TrackerDetailPage /> },
          { path: 'trackers/:id/edit', element: <TrackerFormPage /> },
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

/** The tracker custom fields were added for: volume, plus how and what after. */
async function feedingTracker(test: TestCore) {
  const tracker = await test.createTracker({ name: 'Milk', kind: 'number', unit: 'ml' });
  const fields = await test.core.fields.replace(tracker.id, [
    {
      name: 'Feed type',
      kind: 'choice',
      options: [{ label: 'Bottle' }, { label: 'Formula' }, { label: 'Breast' }],
    },
    { name: 'Wet diaper', kind: 'flag' },
  ]);
  return { tracker, feedType: fields[0]!, wetDiaper: fields[1]! };
}

describe('tracker form — extra details', () => {
  it('creates a tracker with a choice field and its options', async () => {
    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Milk');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.type(screen.getByLabelText('Field name'), 'Feed type');
    await user.type(screen.getByLabelText('Option label'), 'Bottle');
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    const labels = screen.getAllByLabelText('Option label');
    await user.type(labels[1]!, 'Breast');
    await user.click(screen.getByRole('button', { name: 'Create tracker' }));

    await waitFor(async () => {
      const [tracker] = await test.core.trackers.list();
      expect(tracker).toBeDefined();
      const fields = await test.core.fields.list(tracker!.id);
      expect(fields).toHaveLength(1);
      expect(fields[0]!.name).toBe('Feed type');
      expect(fields[0]!.options.map((o) => o.label)).toEqual(['Bottle', 'Breast']);
    });
  });

  it('renaming a field keeps the answers already filed against it', async () => {
    const user = userEvent.setup();
    const { tracker, feedType } = await feedingTracker(test);
    await test.core.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: feedType.options[0]!.id },
    });

    renderApp(test, `/trackers/${tracker.id}/edit`);

    const nameInput = await screen.findByDisplayValue('Feed type');
    await user.clear(nameInput);
    await user.type(nameInput, 'How fed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(async () => {
      const fields = await test.core.fields.list(tracker.id);
      expect(fields[0]!.name).toBe('How fed');
      // Same row, so the entry still points at the option it was logged with.
      expect(fields[0]!.id).toBe(feedType.id);
    });
    const entries = await test.core.entries.forTracker(tracker.id);
    expect(entries[0]!.fields[0]!.option_id).toBe(feedType.options[0]!.id);
  });

  it('refuses to save a choice field with no options', async () => {
    const user = userEvent.setup();
    renderApp(test, '/trackers/new');

    await user.type(await screen.findByLabelText('Name'), 'Milk');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.type(screen.getByLabelText('Field name'), 'Feed type');
    await user.click(screen.getByRole('button', { name: 'Create tracker' }));

    expect(await screen.findByText(/needs at least one option/i)).toBeInTheDocument();
  });
});

describe('logging with custom fields', () => {
  it('records the chosen answers on the detail page and shows them on the entry', async () => {
    const user = userEvent.setup();
    const { tracker, feedType, wetDiaper } = await feedingTracker(test);
    renderApp(test, `/trackers/${tracker.id}`);

    const form = await screen.findByRole('tabpanel', { name: 'Log an entry' });
    await user.type(within(form).getByLabelText('Value'), '120');
    await user.click(within(form).getByRole('button', { name: 'Bottle' }));
    // The flag's Yes/No sit in their own group, so scope the lookup to it.
    const diaperGroup = within(form).getByRole('group', { name: 'Wet diaper' });
    await user.click(within(diaperGroup).getByRole('button', { name: 'Yes' }));
    await user.click(within(form).getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(tracker.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe(120);
      expect(entries[0]!.fields).toHaveLength(2);
      expect(entries[0]!.fields[0]!.option_id).toBe(feedType.options[0]!.id);
      expect(entries[0]!.fields[1]!.number_value).toBe(1);
    });

    // The entry row reads back the answers as chips. Scoped to the row —
    // "Bottle" is also the label of the pill that logged it.
    const row = (await screen.findByText('✓ Wet diaper')).closest('.entry') as HTMLElement;
    expect(within(row).getByText('Bottle')).toBeInTheDocument();
    expect(wetDiaper.kind).toBe('flag');
  });

  it('logs an entry that answers nothing, and lets an answer be cleared again', async () => {
    const user = userEvent.setup();
    const { tracker, feedType } = await feedingTracker(test);
    renderApp(test, `/trackers/${tracker.id}`);

    // No field touched: the form logs exactly as it did before fields existed.
    const form = await screen.findByRole('tabpanel', { name: 'Log an entry' });
    await user.type(within(form).getByLabelText('Value'), '120');
    await user.click(within(form).getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(tracker.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.fields).toEqual([]);
    });

    // Tapping a selected pill a second time takes the answer back off.
    const pill = within(
      await screen.findByRole('tabpanel', { name: 'Log an entry' }),
    ).getByRole('button', { name: 'Bottle' });
    await user.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    await user.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Log entry' }));
    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(tracker.id);
      expect(entries).toHaveLength(2);
      expect(entries[1]!.fields).toEqual([]);
    });
    expect(feedType.kind).toBe('choice');
  });

  it('carries the answers through a quick-log tap, then clears them', async () => {
    const user = userEvent.setup();
    const { tracker, feedType } = await feedingTracker(test);
    renderApp(test, `/trackers/${tracker.id}/quick`);

    await user.click(await screen.findByRole('button', { name: 'Breast' }));
    // A `number` tracker gets the keypad; type the volume on it.
    for (const digit of ['5', '0']) {
      await user.click(within(screen.getByRole('group', { name: 'Number keypad' })).getByRole('button', { name: digit }));
    }
    await user.click(screen.getByRole('button', { name: 'Log entry' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(tracker.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.fields[0]!.option_id).toBe(feedType.options[2]!.id);
    });

    // A sticky answer would silently attach itself to the next feed.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Breast' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });

  it('edits an entry answer in place', async () => {
    const user = userEvent.setup();
    const { tracker, feedType } = await feedingTracker(test);
    await test.core.entries.log(tracker.id, {
      value: 120,
      fields: { [feedType.id]: feedType.options[0]!.id },
    });
    renderApp(test, `/trackers/${tracker.id}`);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    // Both the log form and the row's edit form show the field, so scope to
    // the row being edited.
    const editing = document.querySelector('.entry--editing') as HTMLElement;
    const group = within(editing).getByRole('group', { name: 'Feed type' });
    await user.click(within(group).getByRole('button', { name: 'Formula' }));
    await user.click(within(editing).getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const entries = await test.core.entries.forTracker(tracker.id);
      expect(entries[0]!.fields[0]!.option_id).toBe(feedType.options[1]!.id);
    });
  });
});

describe('breakdown card', () => {
  it('splits the total across a field, listing empty options and blanks', async () => {
    const { tracker, feedType } = await feedingTracker(test);
    const [bottle, , breast] = feedType.options;
    await test.core.entries.log(tracker.id, { value: 120, fields: { [feedType.id]: bottle!.id } });
    await test.core.entries.log(tracker.id, { value: 80, fields: { [feedType.id]: bottle!.id } });
    await test.core.entries.log(tracker.id, { value: 50, fields: { [feedType.id]: breast!.id } });
    await test.core.entries.log(tracker.id, { value: 30 });

    renderApp(test, `/trackers/${tracker.id}`);

    const card = (await screen.findByText('Breakdown')).closest('section')!;
    const rows = within(card).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('Bottle');
    expect(rows[0]).toContain('200');
    expect(rows[0]).toContain('2 entries');
    // An option nothing was logged against still holds its place in the legend.
    expect(rows[1]).toContain('Formula');
    expect(rows[1]).toContain('0 entries');
    expect(rows[2]).toContain('Breast');
    // Unanswered entries are their own bucket, not folded into an answer.
    expect(rows[3]).toContain('Not set');
    expect(rows[3]).toContain('1 entry');
  });

  it('stays hidden for a tracker with no fields', async () => {
    const tracker = await test.createTracker({ name: 'Water', kind: 'count' });
    await test.core.entries.log(tracker.id, { value: 1 });
    renderApp(test, `/trackers/${tracker.id}`);

    await screen.findByRole('heading', { name: 'Water' });
    expect(screen.queryByText('Breakdown')).not.toBeInTheDocument();
  });
});
