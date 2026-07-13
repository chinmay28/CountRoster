import { describe, it, expect } from 'vitest';
import { makeTestApp } from './setup.js';
import {
  sanitizeMerchantName,
  merchantKey,
  TransactionNotFoundError,
} from '../src/domain/transactions.js';
import { DerivedTrackerError } from '../src/domain/derived.js';
import { TrackerNotFoundError } from '../src/domain/trackers.js';

const row = (
  date: string,
  description: string,
  amount: number,
  extra: Record<string, string> = {},
) => ({ date, description, amount, ...extra });

describe('sanitizeMerchantName', () => {
  it('cleans processor prefixes, store numbers, and shouting', () => {
    expect(sanitizeMerchantName("TRADER JOE'S #552")).toBe("Trader Joe's");
    expect(sanitizeMerchantName('SQ *BLUE BOTTLE COFFEE')).toBe('Blue Bottle Coffee');
    expect(sanitizeMerchantName('TST* CHIPOTLE 0417')).toBe('Chipotle');
    expect(sanitizeMerchantName('PAYPAL *SPOTIFY')).toBe('Spotify');
    expect(sanitizeMerchantName('7-ELEVEN 34123')).toBe('7-Eleven');
    expect(sanitizeMerchantName('  Whole   Foods  Market ')).toBe('Whole Foods Market');
    expect(sanitizeMerchantName('AMZN Mktp US')).toBe('AMZN Mktp US'); // has lowercase
  });
});

describe('merchantKey', () => {
  it('normalizes to lowercase alphanumerics', () => {
    expect(merchantKey("Trader Joe's")).toBe('trader joes');
    expect(merchantKey('7-Eleven')).toBe('7 eleven');
  });
});

describe('TransactionService', () => {
  it('imports rows: sanitizes names and suggests via the CSV category', async () => {
    const { app } = await makeTestApp();
    const groceries = await app.trackers.create({ name: 'Groceries', unit: '$' });

    const res = await app.transactions.import({
      transactions: [
        row('2026-07-01', "TRADER JOE'S #552", -43.21, {
          account: 'Amex Gold',
          category: 'groceries',
        }),
        row('2026-07-02', 'SOME NEW PLACE', -10),
      ],
    });

    expect(res.imported).toBe(2);
    expect(res.duplicates).toBe(0);
    const tj = res.transactions[0]!;
    expect(tj.name).toBe("Trader Joe's");
    expect(tj.raw_description).toBe("TRADER JOE'S #552");
    expect(tj.posted_at.startsWith('2026-07-01T12:00:00.000')).toBe(true);
    expect(tj.status).toBe('pending');
    expect(tj.tracker_id).toBe(groceries.id); // case-insensitive name match
    expect(res.transactions[1]!.tracker_id).toBeNull();
  });

  it('deduplicates re-imports but keeps identical same-day purchases', async () => {
    const { app } = await makeTestApp();
    const r = row('2026-07-01', 'CHIPOTLE 0417', -12.5, { account: 'Visa' });

    const first = await app.transactions.import({ transactions: [r, r] });
    expect(first.imported).toBe(2); // two real burritos

    const second = await app.transactions.import({
      transactions: [r, r, row('2026-07-03', 'CHIPOTLE 0417', -9)],
    });
    expect(second.imported).toBe(1);
    expect(second.duplicates).toBe(2);
  });

  it('confirm files an entry + note and learns a rule for the merchant', async () => {
    const { app } = await makeTestApp();
    const dining = await app.trackers.create({ name: 'Restaurants', unit: '$' });

    const res = await app.transactions.import({
      transactions: [row('2026-07-01', 'TST* CHIPOTLE 0417', -12.5)],
    });
    const txn = res.transactions[0]!;
    expect(txn.tracker_id).toBeNull();

    const out = await app.transactions.confirm(txn.id, { tracker_id: dining.id });
    expect(out.entry.tracker_id).toBe(dining.id);
    expect(out.entry.value).toBe(12.5); // spend-positive
    expect(out.entry.occurred_at).toBe(txn.posted_at);
    expect(out.note.body).toBe('Chipotle');
    expect(out.note.entry_id).toBe(out.entry.id);
    expect(out.transaction.status).toBe('confirmed');
    expect(out.transaction.entry_id).toBe(out.entry.id);

    // Rule learned from the raw descriptor: another store number still matches.
    const next = await app.transactions.import({
      transactions: [row('2026-07-09', 'TST* CHIPOTLE 0533', -14)],
    });
    expect(next.transactions[0]!.tracker_id).toBe(dining.id);

    await expect(app.transactions.confirm(txn.id)).rejects.toThrow(
      /Only pending transactions/,
    );
  });

  it('confirm uses the stored suggestion and honors a value override', async () => {
    const { app } = await makeTestApp();
    const dining = await app.trackers.create({ name: 'Restaurants' });

    const res = await app.transactions.import({
      transactions: [row('2026-07-01', 'CAFE', -5, { category: 'Restaurants' })],
    });
    const out = await app.transactions.confirm(res.transactions[0]!.id);
    expect(out.entry.tracker_id).toBe(dining.id);
    expect(out.entry.value).toBe(5);

    const res2 = await app.transactions.import({
      transactions: [row('2026-07-02', 'CAFE', -8, { category: 'Restaurants' })],
    });
    const out2 = await app.transactions.confirm(res2.transactions[0]!.id, { value: 100 });
    expect(out2.entry.value).toBe(100);

    const res3 = await app.transactions.import({
      transactions: [row('2026-07-03', 'MYSTERY', -1)],
    });
    await expect(app.transactions.confirm(res3.transactions[0]!.id)).rejects.toThrow(
      /tracker_id required/,
    );
  });

  it('rejects derived or unknown trackers', async () => {
    const { app } = await makeTestApp();
    const src = await app.trackers.create({ name: 'Src' });
    const derived = await app.trackers.create({
      name: 'Total',
      links: [{ source_id: src.id, coefficient: 1 }],
    });

    const res = await app.transactions.import({
      transactions: [row('2026-07-01', 'CAFE', -5)],
    });
    const id = res.transactions[0]!.id;
    await expect(
      app.transactions.confirm(id, { tracker_id: derived.id }),
    ).rejects.toBeInstanceOf(DerivedTrackerError);
    await expect(
      app.transactions.confirm(id, { tracker_id: 'nope' }),
    ).rejects.toBeInstanceOf(TrackerNotFoundError);
    await expect(app.transactions.confirm('nope')).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
  });

  it('update edits name/tracker/amount on pending rows only', async () => {
    const { app } = await makeTestApp();
    const groceries = await app.trackers.create({ name: 'Groceries' });

    const res = await app.transactions.import({
      transactions: [row('2026-07-01', 'WM SUPERCENTER', -60)],
    });
    const id = res.transactions[0]!.id;

    const updated = await app.transactions.update(id, {
      name: 'Walmart',
      tracker_id: groceries.id,
      amount: -59.5,
    });
    expect(updated.name).toBe('Walmart');
    expect(updated.amount).toBe(-59.5);
    expect(updated.tracker_id).toBe(groceries.id);

    const cleared = await app.transactions.update(id, { tracker_id: null });
    expect(cleared.tracker_id).toBeNull();

    const out = await app.transactions.confirm(id, { tracker_id: groceries.id });
    expect(out.note.body).toBe('Walmart'); // the edited name is the note

    await expect(app.transactions.update(id, { name: 'X' })).rejects.toThrow(
      /Only pending transactions/,
    );
  });

  it('delete dismisses to ignored and the dedupe key still blocks re-import', async () => {
    const { app } = await makeTestApp();
    const r = row('2026-07-01', 'SPAM MERCHANT', -3);

    const res = await app.transactions.import({ transactions: [r] });
    await app.transactions.delete(res.transactions[0]!.id);

    expect(await app.transactions.list()).toHaveLength(0);
    expect(await app.transactions.list('ignored')).toHaveLength(1);

    const again = await app.transactions.import({ transactions: [r] });
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(1);

    await expect(app.transactions.delete('nope')).resolves.toBeUndefined();
  });

  it('deleting an ignored transaction purges it, so it can re-import', async () => {
    const { app } = await makeTestApp();
    const r = row('2026-07-01', 'SPAM MERCHANT', -3);

    const res = await app.transactions.import({ transactions: [r] });
    const id = res.transactions[0]!.id;
    await app.transactions.delete(id); // pending → ignored
    await app.transactions.delete(id); // ignored → gone

    expect(await app.transactions.list('ignored')).toHaveLength(0);
    expect(await app.transactions.list('all')).toHaveLength(0);

    const fresh = await app.transactions.import({ transactions: [r] });
    expect(fresh.imported).toBe(1);
    expect(fresh.duplicates).toBe(0);
  });

  it('list filters by status, newest first', async () => {
    const { app } = await makeTestApp();
    const dining = await app.trackers.create({ name: 'Restaurants' });

    const res = await app.transactions.import({
      transactions: [
        row('2026-07-01', 'A', -1),
        row('2026-07-05', 'B', -2),
        row('2026-07-03', 'C', -3),
      ],
    });
    await app.transactions.confirm(res.transactions[1]!.id, { tracker_id: dining.id });

    const pending = await app.transactions.list();
    expect(pending.map((t) => t.name)).toEqual(['C', 'A']);
    const all = await app.transactions.list('all');
    expect(all.map((t) => t.name)).toEqual(['B', 'C', 'A']);
  });

  it('validates import input', async () => {
    const { app } = await makeTestApp();
    await expect(
      app.transactions.import({ transactions: [] }),
    ).rejects.toThrow();
    await expect(
      app.transactions.import({
        transactions: [row('07/01/2026', 'X', -1)],
      }),
    ).rejects.toThrow();
  });
});
