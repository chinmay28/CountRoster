import type { Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import { toLocalISO, type Clock } from '../time.js';
import type { CardTransaction, Entry, Note } from '../schema/tables.js';
import {
  transactionImportSchema,
  transactionPatchSchema,
  transactionConfirmSchema,
  type TransactionImportInput,
  type TransactionPatch,
  type TransactionConfirmInput,
} from '../schema/validators.js';
import { DerivedTrackerError } from './derived.js';
import { TrackerNotFoundError } from './trackers.js';

/** What one import produced: new rows vs. rows the dedupe key already knew. */
export interface TransactionImportResult {
  imported: number;
  duplicates: number;
  transactions: CardTransaction[];
}

/** What confirming a transaction produced. */
export interface TransactionConfirmResult {
  transaction: CardTransaction;
  entry: Entry;
  note: Note;
}

export type TransactionListStatus = 'pending' | 'confirmed' | 'ignored' | 'all';

/**
 * The staging inbox for imported credit-card transactions. Rows arrive
 * `pending` with a suggested tracker (learned category_rules first, then the
 * CSV category matched against tracker names); confirming files an Entry plus
 * a Note carrying the transaction name. Deleting marks the row `ignored`
 * instead of removing it so re-importing an overlapping CSV can't resurrect
 * it. Mirrors the Go server's TransactionService — behavior must not drift.
 */
export interface TransactionService {
  import(input: TransactionImportInput): Promise<TransactionImportResult>;
  list(status?: TransactionListStatus): Promise<CardTransaction[]>;
  get(id: string): Promise<CardTransaction | null>;
  update(id: string, patch: TransactionPatch): Promise<CardTransaction>;
  delete(id: string): Promise<void>;
  confirm(id: string, input?: TransactionConfirmInput): Promise<TransactionConfirmResult>;
}

export class TransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`Transaction not found: ${id}`);
    this.name = 'TransactionNotFoundError';
  }
}

const DERIVED_FILE_MESSAGE =
  'Cannot file transactions into a derived tracker; its value is computed from its sources.';

/** Joins dedupe-key parts; the unit separator can't appear in CSV text. */
const DEDUPE_SEP = '\u001f';

/**
 * Turn a raw card descriptor into a display name: collapse whitespace, strip
 * processor prefixes ("SQ *", "TST*", "PAYPAL *") and trailing store numbers,
 * and title-case all-caps descriptors. Mirrors the Go SanitizeMerchantName —
 * the two must produce identical names.
 */
export function sanitizeMerchantName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  let cleaned = s.replace(/^[A-Za-z]{2,10} ?\* */, '');
  // A bare trailing number needs 4+ digits so names like "PIER 1" survive.
  cleaned = cleaned.replace(/( (#\d{2,}|\d{4,}))+$/, '').trim();
  if (cleaned === '') cleaned = s;
  return titleCaseIfShouty(cleaned);
}

/**
 * Title-case a string that has letters but no lowercase ones. A letter is
 * uppercased at the start and after a space, '-', '/', '.', or '&' — but not
 * after an apostrophe, so "JOE'S" becomes "Joe's".
 */
function titleCaseIfShouty(s: string): string {
  const hasLetter = /[A-Za-z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  if (!hasLetter || hasLower) return s;
  let out = '';
  let boundary = true;
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') {
      out += boundary ? ch : ch.toLowerCase();
    } else {
      out += ch;
    }
    boundary = ch === ' ' || ch === '-' || ch === '/' || ch === '.' || ch === '&';
  }
  return out;
}

/**
 * Normalize a sanitized name into the key category_rules match on:
 * lowercase alphanumerics with single spaces, apostrophes dropped.
 */
export function merchantKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Render a plain YYYY-MM-DD as local noon — mid-day keeps the transaction
 * inside its calendar day regardless of DST or day_start_minute. */
function localNoonISO(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return toLocalISO(new Date(y, m - 1, d, 12, 0, 0, 0));
}

export function createTransactionService(
  storage: Storage,
  clock: Clock,
): TransactionService {
  return new TransactionServiceImpl(storage, clock);
}

class TransactionServiceImpl implements TransactionService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  async import(rawInput: TransactionImportInput): Promise<TransactionImportResult> {
    const input = transactionImportSchema.parse(rawInput);

    let imported = 0;
    let duplicates = 0;
    const newIds: string[] = [];
    await this.storage.transaction(async (tx) => {
      const now = this.clock.nowISO();
      const seen = new Map<string, number>();
      for (const item of input.transactions) {
        const base = [
          item.date,
          String(item.amount),
          item.description,
          item.account ?? '',
        ].join(DEDUPE_SEP);
        const ordinal = seen.get(base) ?? 0;
        seen.set(base, ordinal + 1);
        const key = base + DEDUPE_SEP + String(ordinal);

        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM card_transactions WHERE dedupe_key = ?`,
          [key],
        );
        if (existing.length > 0) {
          duplicates++;
          continue;
        }

        const name = sanitizeMerchantName(item.description);
        const trackerId = await suggestTracker(tx, merchantKey(name), item.category);

        const id = newId();
        await tx.exec(
          `INSERT INTO card_transactions
             (id, posted_at, amount, name, raw_description, account, category,
              dedupe_key, status, tracker_id, entry_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
          [
            id, localNoonISO(item.date), item.amount, name, item.description,
            item.account ?? null, item.category ?? null, key, trackerId,
            now, now,
          ],
        );
        newIds.push(id);
        imported++;
      }
    });

    const transactions: CardTransaction[] = [];
    for (const id of newIds) {
      const txn = await this.get(id);
      if (!txn) throw new Error(`Transaction insert succeeded but row not found: ${id}`);
      transactions.push(txn);
    }
    return { imported, duplicates, transactions };
  }

  async list(status: TransactionListStatus = 'pending'): Promise<CardTransaction[]> {
    if (status === 'all') {
      return this.storage.query<CardTransaction>(
        `SELECT * FROM card_transactions ORDER BY posted_at DESC, id DESC`,
      );
    }
    if (status !== 'pending' && status !== 'confirmed' && status !== 'ignored') {
      throw new Error(
        `Invalid status "${String(status)}"; expected pending, confirmed, ignored, or all`,
      );
    }
    return this.storage.query<CardTransaction>(
      `SELECT * FROM card_transactions WHERE status = ?
       ORDER BY posted_at DESC, id DESC`,
      [status],
    );
  }

  async get(id: string): Promise<CardTransaction | null> {
    const rows = await this.storage.query<CardTransaction>(
      `SELECT * FROM card_transactions WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async update(id: string, rawPatch: TransactionPatch): Promise<CardTransaction> {
    const patch = transactionPatchSchema.parse(rawPatch);
    const existing = await this.get(id);
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.status !== 'pending') {
      throw new Error('Only pending transactions can be edited');
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.tracker_id !== undefined) {
      if (patch.tracker_id === null) {
        sets.push('tracker_id = NULL');
      } else {
        await checkAssignableTracker(this.storage, patch.tracker_id);
        sets.push('tracker_id = ?');
        params.push(patch.tracker_id);
      }
    }
    if (patch.amount !== undefined) {
      sets.push('amount = ?');
      params.push(patch.amount);
    }
    if (patch.posted_at !== undefined) {
      sets.push('posted_at = ?');
      params.push(patch.posted_at);
    }
    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(this.clock.nowISO(), id);
    await this.storage.exec(
      `UPDATE card_transactions SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) throw new TransactionNotFoundError(id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return; // silent no-op, like entries/notes
    if (existing.status === 'confirmed') {
      throw new Error('Only pending transactions can be deleted');
    }
    if (existing.status === 'ignored') return;
    await this.storage.exec(
      `UPDATE card_transactions SET status = 'ignored', updated_at = ? WHERE id = ?`,
      [this.clock.nowISO(), id],
    );
  }

  async confirm(
    id: string,
    rawInput: TransactionConfirmInput = {},
  ): Promise<TransactionConfirmResult> {
    const input = transactionConfirmSchema.parse(rawInput);
    const txn = await this.get(id);
    if (!txn) throw new TransactionNotFoundError(id);
    if (txn.status !== 'pending') {
      throw new Error('Only pending transactions can be confirmed');
    }

    const trackerId = input.tracker_id ?? txn.tracker_id;
    if (!trackerId) {
      throw new Error('tracker_id required (no tracker suggested for this transaction)');
    }
    await checkAssignableTracker(this.storage, trackerId);

    // Spend-positive default: bank exports carry debits as negative amounts.
    const value = input.value ?? -txn.amount;

    const entryId = newId();
    const noteId = newId();
    await this.storage.transaction(async (tx) => {
      const now = this.clock.nowISO();
      await tx.exec(
        `INSERT INTO entries (id, tracker_id, value, occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [entryId, trackerId, value, txn.posted_at, now, now],
      );
      await tx.exec(
        `INSERT INTO notes (id, tracker_id, entry_id, body, occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [noteId, trackerId, entryId, txn.name, txn.posted_at, now, now],
      );
      await tx.exec(
        `UPDATE card_transactions
            SET status = 'confirmed', tracker_id = ?, entry_id = ?, updated_at = ?
          WHERE id = ?`,
        [trackerId, entryId, now, id],
      );
      // Learn the categorization, keyed on the *raw* descriptor's merchant so
      // future imports of the same merchant match even if the name was edited.
      const merchant = merchantKey(sanitizeMerchantName(txn.raw_description));
      if (merchant !== '') {
        await tx.exec(
          `INSERT INTO category_rules (id, merchant, tracker_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (merchant)
           DO UPDATE SET tracker_id = excluded.tracker_id, updated_at = excluded.updated_at`,
          [newId(), merchant, trackerId, now, now],
        );
      }
    });

    const transaction = await this.get(id);
    const entries = await this.storage.query<Entry>(
      `SELECT * FROM entries WHERE id = ?`,
      [entryId],
    );
    const notes = await this.storage.query<Note>(
      `SELECT * FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!transaction || !entries[0] || !notes[0]) {
      throw new Error(`Transaction confirm succeeded but rows not found: ${id}`);
    }
    return { transaction, entry: entries[0], note: notes[0] };
  }
}

/** The auto-categorization for a new transaction: a learned rule wins;
 * otherwise the CSV category is matched against active tracker names. */
async function suggestTracker(
  tx: Storage,
  merchant: string,
  category: string | null | undefined,
): Promise<string | null> {
  if (merchant !== '') {
    const rules = await tx.query<{ tracker_id: string }>(
      `SELECT tracker_id FROM category_rules WHERE merchant = ?`,
      [merchant],
    );
    if (rules[0]) return rules[0].tracker_id;
  }
  const trimmed = category?.trim();
  if (trimmed) {
    const trackers = await tx.query<{ id: string }>(
      `SELECT id FROM trackers
        WHERE archived_at IS NULL AND is_derived = 0 AND lower(name) = lower(?)
        ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT 1`,
      [trimmed],
    );
    if (trackers[0]) return trackers[0].id;
  }
  return null;
}

/** A tracker a transaction is pointed at must exist and not be derived. */
async function checkAssignableTracker(st: Storage, trackerId: string): Promise<void> {
  const rows = await st.query<{ is_derived: 0 | 1 }>(
    `SELECT is_derived FROM trackers WHERE id = ?`,
    [trackerId],
  );
  if (!rows[0]) throw new TrackerNotFoundError(trackerId);
  if (rows[0].is_derived === 1) throw new DerivedTrackerError(DERIVED_FILE_MESSAGE);
}
