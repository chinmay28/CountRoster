import type { TransactionImportItem } from '@countroster/core';

/**
 * Parse a transactions CSV (Empower Personal Dashboard's export, and any
 * other bank/aggregator CSV with recognizable columns) into the rows the
 * server's import endpoint takes. Pure format decoding — sanitizing,
 * dedupe and categorization all happen server-side.
 *
 * Empower's export looks like:
 *   "Date","Account","Description","Category","Tags","Amount"
 *   "2026-07-01","Amex Gold","TRADER JOE'S #552","Groceries","","-43.21"
 *
 * Column matching is header-driven and case-insensitive, so column order and
 * extra columns don't matter.
 */

export interface ParsedTransactionsCsv {
  transactions: TransactionImportItem[];
  /** Data rows that couldn't be read (bad date or amount). */
  skipped: number;
}

/** RFC 4180-ish CSV reader: quoted fields, embedded commas/quotes/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (sawAny && (field !== '' || row.length > 0)) endRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** "2026-07-01" or "7/1/2026" → "2026-07-01"; null if unreadable. */
function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  return null;
}

/** "-$1,234.56" or "(1234.56)" → -1234.56; null if unreadable. */
function normalizeAmount(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findColumn(header: string[], ...names: string[]): number {
  const lowered = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = lowered.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Map parsed CSV rows to import items. Throws with a readable message when
 * the header doesn't look like a transactions export at all.
 */
export function parseTransactionsCsv(text: string): ParsedTransactionsCsv {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('The file is empty.');

  const header = rows[0]!;
  const dateCol = findColumn(header, 'date', 'transaction date', 'posted date');
  const descCol = findColumn(header, 'description', 'merchant', 'payee', 'name');
  const amountCol = findColumn(header, 'amount');
  if (dateCol === -1 || descCol === -1 || amountCol === -1) {
    throw new Error(
      'Could not find Date, Description, and Amount columns. ' +
        'Export transactions as CSV from Empower and upload that file.',
    );
  }
  const accountCol = findColumn(header, 'account', 'account name');
  const categoryCol = findColumn(header, 'category');

  const transactions: TransactionImportItem[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const date = normalizeDate(row[dateCol] ?? '');
    const amount = normalizeAmount(row[amountCol] ?? '');
    const description = (row[descCol] ?? '').trim();
    if (!date || amount === null || description === '') {
      skipped++;
      continue;
    }
    const account = accountCol === -1 ? '' : (row[accountCol] ?? '').trim();
    const category = categoryCol === -1 ? '' : (row[categoryCol] ?? '').trim();
    transactions.push({
      date,
      description,
      amount,
      ...(account !== '' ? { account } : {}),
      ...(category !== '' ? { category } : {}),
    });
  }
  return { transactions, skipped };
}
