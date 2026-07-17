import type { TransactionImportItem } from '@countroster/core';

/**
 * Parse a transactions CSV (Empower Personal Dashboard's export, US Bank's
 * credit-card export, and any other bank/aggregator CSV with recognizable
 * columns) into the rows the server's import endpoint takes. Pure format
 * decoding — sanitizing, dedupe and categorization all happen server-side.
 *
 * Empower's export looks like:
 *   "Transactions For All Accounts from Jan 2026 to Jul 2026"
 *   Date,Description,Category,Firm Name,Account Name,Amount,Tags
 *   "2026-07-12","Coffee Corner","Restaurants","Some Bank","Credit Card - Ending in 7291","-$12.34",""
 *
 * US Bank's export looks like:
 *   "Date","Transaction","Name","Memo","Amount"
 *   "2026-06-30","DEBIT","CHIPOTLE 3293          SANTA CLARA   CA","24431066181458859822737; 05814; ; ; ;","-15.91"
 * Its "Name" column is the merchant (matched by the 'name' alias below) and
 * it carries no Category column — instead each Memo embeds the card-network
 * MCC (Merchant Category Code) as its second ';'-delimited field, which we
 * map to a category label so US Bank rows auto-categorize like Empower's do
 * (see categoryFromMemo).
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

/**
 * Best-effort map of card-network MCCs (Merchant Category Codes) to a plain
 * category label, used for US Bank exports that carry an MCC but no Category
 * column. Labels are broad, conventional spending buckets so they have a
 * chance of matching a tracker's name server-side; it's only a suggestion the
 * user reviews, so codes we don't list simply import uncategorized (and once a
 * merchant is filed the server's learned rule takes over regardless).
 */
const MCC_CATEGORIES: Record<string, string> = {
  // Dining — caterers, restaurants, bars, fast food.
  '5811': 'Dining', '5812': 'Dining', '5813': 'Dining', '5814': 'Dining',
  // Groceries — supermarkets, meat/freezer, dairy, bakeries, specialty food.
  '5411': 'Groceries', '5422': 'Groceries', '5451': 'Groceries',
  '5462': 'Groceries', '5499': 'Groceries',
  // Gas & auto — fuel, EV charging, parts, service, car washes.
  '5541': 'Gas', '5542': 'Gas',
  '5533': 'Auto', '5552': 'Auto', '7538': 'Auto', '7542': 'Auto', '7549': 'Auto',
  // Health — pharmacies, medical supplies, doctors, dentists, hospitals, labs.
  '5047': 'Health', '5122': 'Health', '5912': 'Health',
  '8011': 'Health', '8021': 'Health', '8031': 'Health', '8041': 'Health',
  '8042': 'Health', '8049': 'Health', '8062': 'Health', '8071': 'Health',
  '8099': 'Health',
  // Home — home-improvement warehouses, building materials, hardware,
  // appliances, and the trade contractors who install them.
  '1799': 'Home', '5200': 'Home', '5211': 'Home', '5231': 'Home',
  '5251': 'Home', '5261': 'Home', '5722': 'Home',
  // Clothing — apparel of every stripe plus cosmetics.
  '5611': 'Clothing', '5621': 'Clothing', '5631': 'Clothing', '5641': 'Clothing',
  '5651': 'Clothing', '5661': 'Clothing', '5691': 'Clothing', '5699': 'Clothing',
  '5977': 'Clothing',
  // Shopping — wholesale clubs, discount/department/variety, electronics,
  // books, office/craft/toy supplies, and misc retail.
  '5065': 'Shopping', '5300': 'Shopping', '5310': 'Shopping', '5311': 'Shopping',
  '5331': 'Shopping', '5732': 'Shopping', '5942': 'Shopping', '5943': 'Shopping',
  '5945': 'Shopping', '5970': 'Shopping', '5999': 'Shopping',
  // Fitness — gyms, membership clubs, recreation.
  '7941': 'Fitness', '7991': 'Fitness', '7997': 'Fitness',
  // Subscriptions & digital — software, digital goods, online services.
  '4816': 'Subscriptions', '5734': 'Subscriptions', '5815': 'Subscriptions',
  '5816': 'Subscriptions', '5817': 'Subscriptions', '5818': 'Subscriptions',
  '5968': 'Subscriptions',
  // Bills — insurance and utilities.
  '6300': 'Insurance',
  '4814': 'Utilities', '4899': 'Utilities', '4900': 'Utilities',
  // Government — agencies, tax payments, courts.
  '9211': 'Government', '9222': 'Government', '9311': 'Government',
  '9399': 'Government',
  // Family — childcare and schools.
  '8211': 'Childcare', '8351': 'Childcare',
  // Travel — airlines/taxis/transit, tolls, hotels, car rental, agencies.
  '4111': 'Travel', '4121': 'Travel', '4131': 'Travel', '4784': 'Travel',
  '5962': 'Travel', '7011': 'Travel', '7512': 'Travel',
};

/**
 * US Bank puts the MCC in the Memo's second ';'-delimited field, zero-padded:
 *   "24431066181458859822737; 05814; ; ; ;" → MCC 5814 → "Dining".
 * Returns '' when there's no recognizable MCC or we don't map it.
 */
function categoryFromMemo(memo: string): string {
  const parts = memo.split(';');
  if (parts.length < 2) return '';
  const code = parseInt((parts[1] ?? '').trim(), 10);
  if (!Number.isInteger(code) || code <= 0) return '';
  return MCC_CATEGORIES[String(code)] ?? '';
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
  // US Bank has no Category column but embeds an MCC in the Memo field.
  const memoCol = findColumn(header, 'memo');

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
    let category = categoryCol === -1 ? '' : (row[categoryCol] ?? '').trim();
    if (category === '' && memoCol !== -1) {
      category = categoryFromMemo(row[memoCol] ?? '');
    }
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
