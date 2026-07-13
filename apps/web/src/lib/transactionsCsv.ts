import type { TransactionImportItem } from '@countroster/core';

/**
 * Parse a transactions CSV (Empower Personal Dashboard's export, and any
 * other bank/aggregator CSV with recognizable columns) into the rows the
 * server's import endpoint takes. Pure format decoding — sanitizing,
 * dedupe and categorization all happen server-side.
 *
 * Empower's export looks like:
 *   "Transactions For All Accounts from Jan 2026 to Jul 2026"
 *   Date,Description,Category,Firm Name,Account Name,Amount,Tags
 *   "2026-07-12","Coffee Corner","Restaurants","Some Bank","Credit Card - Ending in 7291","-$12.34",""
 *
 * Column matching is header-driven and case-insensitive, and the header row
 * is located by scanning the first rows (Empower puts a title line above
 * it), so column order, extra columns, and preamble lines don't matter.
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

  // The header isn't necessarily the first row: Empower writes a title line
  // ("Transactions For All Accounts from …") above it. Scan the first rows
  // for the one that carries the columns we need.
  const isHeader = (row: string[]) =>
    findColumn(row, 'date', 'transaction date', 'posted date') !== -1 &&
    findColumn(row, 'description', 'merchant', 'payee', 'name') !== -1 &&
    findColumn(row, 'amount') !== -1;
  const headerIdx = rows.slice(0, 10).findIndex(isHeader);
  if (headerIdx === -1) {
    throw new Error(
      'Could not find Date, Description, and Amount columns. ' +
        'Export transactions as CSV from Empower and upload that file.',
    );
  }

  const header = rows[headerIdx]!;
  const dateCol = findColumn(header, 'date', 'transaction date', 'posted date');
  const descCol = findColumn(header, 'description', 'merchant', 'payee', 'name');
  const amountCol = findColumn(header, 'amount');
  const accountCol = findColumn(header, 'account', 'account name');
  // Empower splits the institution ("Some Bank") from the account ("Credit
  // Card - Ending in 7291"); joined they make the account label unambiguous.
  const firmCol = findColumn(header, 'firm name', 'firm', 'institution');
  const categoryCol = findColumn(header, 'category');

  const transactions: TransactionImportItem[] = [];
  let skipped = 0;
  for (const row of rows.slice(headerIdx + 1)) {
    const date = normalizeDate(row[dateCol] ?? '');
    const amount = normalizeAmount(row[amountCol] ?? '');
    const description = (row[descCol] ?? '').trim();
    if (!date || amount === null || description === '') {
      skipped++;
      continue;
    }
    const accountName = accountCol === -1 ? '' : (row[accountCol] ?? '').trim();
    const firm = firmCol === -1 ? '' : (row[firmCol] ?? '').trim();
    const account = [firm, accountName].filter((s) => s !== '').join(' · ').slice(0, 120);
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
