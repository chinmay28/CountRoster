import { describe, it, expect } from 'vitest';
import { parseCsv, parseTransactionsCsv } from './transactionsCsv.ts';

describe('parseCsv', () => {
  it('handles quoted fields with commas, quotes, and newlines', () => {
    const rows = parseCsv('a,"b,c","say ""hi""","two\nlines"\r\n1,2,3,4\n');
    expect(rows).toEqual([
      ['a', 'b,c', 'say "hi"', 'two\nlines'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('drops blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseTransactionsCsv', () => {
  const empower = [
    '"Date","Account","Description","Category","Tags","Amount"',
    '"2026-07-01","Amex Gold","TRADER JOE\'S #552","Groceries","","-43.21"',
    '"2026-07-02","Visa","SQ *BLUE BOTTLE","Restaurants","","-5.50"',
  ].join('\n');

  it('maps Empower columns to import items', () => {
    const { transactions, skipped } = parseTransactionsCsv(empower);
    expect(skipped).toBe(0);
    expect(transactions).toEqual([
      {
        date: '2026-07-01',
        description: "TRADER JOE'S #552",
        amount: -43.21,
        account: 'Amex Gold',
        category: 'Groceries',
      },
      {
        date: '2026-07-02',
        description: 'SQ *BLUE BOTTLE',
        amount: -5.5,
        account: 'Visa',
        category: 'Restaurants',
      },
    ]);
  });

  it('parses the real Empower shape: title line, Firm Name split, $-amounts', () => {
    const csv = [
      '"Transactions For All Accounts from Jan 2026 to Jul 2026"',
      'Date,Description,Category,Firm Name,Account Name,Amount,Tags',
      '"2026-07-12","Coffee Corner","Restaurants","Some Bank","Credit Card ( ) - Ending in 7291","-$12.34",""',
      '"2026-07-03","Payment Thank You-mobile","Credit Card Payments","Some Bank","Credit Card ( ) - Ending in 5162","$1,234.56",""',
    ].join('\n');
    const { transactions, skipped } = parseTransactionsCsv(csv);
    expect(skipped).toBe(0);
    expect(transactions).toEqual([
      {
        date: '2026-07-12',
        description: 'Coffee Corner',
        amount: -12.34,
        account: 'Some Bank · Credit Card ( ) - Ending in 7291',
        category: 'Restaurants',
      },
      {
        date: '2026-07-03',
        description: 'Payment Thank You-mobile',
        amount: 1234.56,
        account: 'Some Bank · Credit Card ( ) - Ending in 5162',
        category: 'Credit Card Payments',
      },
    ]);
  });

  it('parses US Bank credit-card exports: Name column, MCC from Memo → category', () => {
    const csv = [
      '"Date","Transaction","Name","Memo","Amount"',
      '"2026-06-30","DEBIT","CHIPOTLE 3293          SANTA CLARA   CA","24431066181458859822737; 05814; ; ; ;","-15.91"',
      '"2026-06-29","DEBIT","WHOLEFDS CBL 10033     CAMPBELL      CA","24137466179001936486648; 05411; ; ; ;","-21.56"',
      '"2026-06-17","CREDIT","PAYMENT   THANK YOU","WEB AUTOMTC; 00300; ; ; ;","6327.90"',
    ].join('\n');
    const { transactions, skipped } = parseTransactionsCsv(csv);
    expect(skipped).toBe(0);
    expect(transactions).toEqual([
      {
        date: '2026-06-30',
        description: 'CHIPOTLE 3293          SANTA CLARA   CA',
        amount: -15.91,
        category: 'Dining',
      },
      {
        date: '2026-06-29',
        description: 'WHOLEFDS CBL 10033     CAMPBELL      CA',
        amount: -21.56,
        category: 'Groceries',
      },
      // MCC 00300 isn't a spending category, so a card payment stays uncategorized.
      { date: '2026-06-17', description: 'PAYMENT   THANK YOU', amount: 6327.9 },
    ]);
  });

  it('does not derive a Memo MCC when the export already has a Category column', () => {
    const csv = [
      'Date,Description,Category,Memo,Amount',
      '"2026-07-01","Corner Cafe","Coffee","xref; 05411; ; ; ;","-4.00"',
    ].join('\n');
    const { transactions } = parseTransactionsCsv(csv);
    // Empower's own Category wins; the Memo's grocery MCC is ignored.
    expect(transactions).toEqual([
      { date: '2026-07-01', description: 'Corner Cafe', amount: -4, category: 'Coffee' },
    ]);
  });

  it('is header-driven: column order and case do not matter', () => {
    const csv = 'AMOUNT,description,DATE\n"-$1,234.56",Rent,7/1/2026\n(12.00),Cafe,07/09/2026';
    const { transactions } = parseTransactionsCsv(csv);
    expect(transactions).toEqual([
      { date: '2026-07-01', description: 'Rent', amount: -1234.56 },
      { date: '2026-07-09', description: 'Cafe', amount: -12 },
    ]);
  });

  it('skips unreadable data rows but keeps the rest', () => {
    const csv = 'Date,Description,Amount\nnot-a-date,X,-1\n2026-07-01,Y,abc\n2026-07-02,Z,-2';
    const { transactions, skipped } = parseTransactionsCsv(csv);
    expect(skipped).toBe(2);
    expect(transactions).toEqual([
      { date: '2026-07-02', description: 'Z', amount: -2 },
    ]);
  });

  it('rejects files without the expected columns', () => {
    expect(() => parseTransactionsCsv('foo,bar\n1,2')).toThrow(/Date, Description/);
    expect(() => parseTransactionsCsv('')).toThrow(/empty/);
  });
});
