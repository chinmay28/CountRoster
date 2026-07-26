import type { SqlParam, Storage } from '../storage/adapter.js';
import { newId } from '../ids.js';
import type { Clock } from '../time.js';
import type {
  Entry,
  EntryFieldValue,
  TrackerField,
  TrackerFieldOption,
} from '../schema/tables.js';
import {
  trackerFieldsInputSchema,
  type EntryFieldAnswers,
  type TrackerFieldInput,
} from '../schema/validators.js';
import { TrackerNotFoundError } from './trackers.js';
import { DerivedTrackerError } from './derived.js';

/** Longest a `text` answer may be. */
export const MAX_FIELD_TEXT_LENGTH = 500;

const DERIVED_FIELDS_MESSAGE =
  'Cannot define fields on a derived tracker; it has no entries of its own.';

/**
 * A tracker's custom fields: the extra details recorded alongside each entry's
 * primary value, and the options a `choice` field offers.
 */
export interface FieldService {
  /** A tracker's fields in sort order, each with its options. */
  list(trackerId: string): Promise<TrackerField[]>;
  /**
   * Rewrite a tracker's whole field set. An input carrying the `id` of an
   * existing field (or option) updates that row in place, so the answers
   * already recorded against it survive; anything the payload leaves out is
   * deleted, taking its recorded answers with it.
   */
  replace(
    trackerId: string,
    fields: readonly TrackerFieldInput[],
  ): Promise<TrackerField[]>;
}

/** Thrown when an answer doesn't match its field's declared kind. */
export class FieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldValueError';
  }
}

/** Thrown when a field id doesn't belong to the tracker in question. */
export class FieldNotFoundError extends Error {
  constructor(id: string) {
    super(`Tracker field not found: ${id}`);
    this.name = 'FieldNotFoundError';
  }
}

export function createFieldService(storage: Storage, clock: Clock): FieldService {
  return new FieldServiceImpl(storage, clock);
}

class FieldServiceImpl implements FieldService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  list(trackerId: string): Promise<TrackerField[]> {
    return listFields(this.storage, trackerId);
  }

  async replace(
    trackerId: string,
    rawFields: readonly TrackerFieldInput[],
  ): Promise<TrackerField[]> {
    const fields = trackerFieldsInputSchema.parse(rawFields);

    const trackerRows = await this.storage.query<{ is_derived: number }>(
      `SELECT is_derived FROM trackers WHERE id = ?`,
      [trackerId],
    );
    if (trackerRows.length === 0) throw new TrackerNotFoundError(trackerId);
    if (trackerRows[0]!.is_derived === 1) {
      throw new DerivedTrackerError(DERIVED_FIELDS_MESSAGE);
    }

    const now = this.clock.nowISO();
    await this.storage.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM tracker_fields WHERE tracker_id = ?`,
        [trackerId],
      );
      const kindById = new Map(existing.map((r) => [r.id, r.kind]));

      // An id the payload doesn't name belongs to a field the user removed —
      // drop it and everything recorded against it.
      const keep = new Set(
        fields.map((f) => f.id).filter((id): id is string => !!id && kindById.has(id)),
      );
      for (const id of kindById.keys()) {
        if (keep.has(id)) continue;
        await tx.exec(`DELETE FROM tracker_fields WHERE id = ?`, [id]);
      }

      for (const [i, field] of fields.entries()) {
        let fieldId = field.id ?? '';
        if (!keep.has(fieldId)) {
          fieldId = newId();
          await tx.exec(
            `INSERT INTO tracker_fields
               (id, tracker_id, name, kind, unit, sort_order,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [fieldId, trackerId, field.name, field.kind, field.unit ?? null, i, now, now],
          );
        } else {
          await tx.exec(
            `UPDATE tracker_fields
                SET name = ?, kind = ?, unit = ?, sort_order = ?, updated_at = ?
              WHERE id = ?`,
            [field.name, field.kind, field.unit ?? null, i, now, fieldId],
          );
          // Answers live in the column the old kind dictated, so they mean
          // nothing under the new one — clear them rather than leaving a flag
          // reading as an orphaned option id.
          if (kindById.get(fieldId) !== field.kind) {
            await tx.exec(`DELETE FROM entry_field_values WHERE field_id = ?`, [fieldId]);
          }
        }
        await replaceFieldOptions(tx, fieldId, field.options);
      }
    });

    return this.list(trackerId);
  }
}

export async function listFields(
  storage: Storage,
  trackerId: string,
): Promise<TrackerField[]> {
  const rows = await storage.query<Omit<TrackerField, 'options'>>(
    `SELECT * FROM tracker_fields WHERE tracker_id = ?
      ORDER BY sort_order ASC, created_at ASC`,
    [trackerId],
  );
  const fields: TrackerField[] = rows.map((r) => ({ ...r, options: [] }));
  if (fields.length === 0) return fields;

  const byId = new Map(fields.map((f) => [f.id, f]));
  const options = await storage.query<TrackerFieldOption>(
    `SELECT o.* FROM tracker_field_options o
       JOIN tracker_fields f ON f.id = o.field_id
      WHERE f.tracker_id = ?
      ORDER BY o.sort_order ASC, o.id ASC`,
    [trackerId],
  );
  for (const option of options) byId.get(option.field_id)?.options.push(option);
  return fields;
}

/**
 * Reconcile one field's options the way `replace` reconciles fields: named ids
 * are updated in place, the rest are dropped.
 */
async function replaceFieldOptions(
  tx: Storage,
  fieldId: string,
  // Structural rather than the schema's type: this runs on values Zod has
  // already parsed, where the defaults are filled in.
  inputs: readonly {
    id?: string | undefined;
    label: string;
    color?: string | null | undefined;
  }[],
): Promise<void> {
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM tracker_field_options WHERE field_id = ?`,
    [fieldId],
  );
  const known = new Set(existing.map((r) => r.id));
  const keep = new Set(
    inputs.map((o) => o.id).filter((id): id is string => !!id && known.has(id)),
  );
  for (const id of known) {
    if (keep.has(id)) continue;
    await tx.exec(`DELETE FROM tracker_field_options WHERE id = ?`, [id]);
  }

  for (const [i, option] of inputs.entries()) {
    if (option.id && keep.has(option.id)) {
      await tx.exec(
        `UPDATE tracker_field_options SET label = ?, color = ?, sort_order = ?
          WHERE id = ?`,
        [option.label, option.color ?? null, i, option.id],
      );
      continue;
    }
    await tx.exec(
      `INSERT INTO tracker_field_options (id, field_id, label, color, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [newId(), fieldId, option.label, option.color ?? null, i],
    );
  }
}

// --- writing entry answers -----------------------------------------------------

/** A field's definition reduced to what validating an answer needs. */
interface FieldDef {
  id: string;
  name: string;
  kind: string;
  optionIds: Set<string>;
}

/** A tracker's field definitions, keyed by id and in sort order. */
async function loadFieldDefs(
  storage: Storage,
  trackerId: string,
): Promise<FieldDef[]> {
  const rows = await storage.query<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM tracker_fields WHERE tracker_id = ?
      ORDER BY sort_order ASC, created_at ASC`,
    [trackerId],
  );
  const defs: FieldDef[] = rows.map((r) => ({ ...r, optionIds: new Set<string>() }));
  if (defs.length === 0) return defs;

  const byId = new Map(defs.map((d) => [d.id, d]));
  const options = await storage.query<{ id: string; field_id: string }>(
    `SELECT o.id AS id, o.field_id AS field_id FROM tracker_field_options o
       JOIN tracker_fields f ON f.id = o.field_id
      WHERE f.tracker_id = ?`,
    [trackerId],
  );
  for (const option of options) byId.get(option.field_id)?.optionIds.add(option.id);
  return defs;
}

/** One answer ready to persist. `set` false means it was cleared. */
export interface ResolvedField {
  fieldId: string;
  set: boolean;
  option: string | null;
  number: number | null;
  text: string | null;
}

/**
 * Interpret raw answers against the tracker's field definitions. An answer
 * that is given must match its field's kind, but no field is ever *obliged*
 * to have one: leaving a field blank is a legitimate state, not an error.
 *
 * That is what keeps fields backward compatible. Adding a field to a tracker
 * can't retroactively invalidate the entries logged before it existed, and an
 * older client — or any write path that predates the field — keeps working
 * untouched. "Unanswered" is carried through to the breakdown as its own
 * bucket rather than being guessed at.
 */
export async function resolveEntryFields(
  storage: Storage,
  trackerId: string,
  answers: EntryFieldAnswers | undefined,
): Promise<ResolvedField[]> {
  const defs = await loadFieldDefs(storage, trackerId);
  const byId = new Map(defs.map((d) => [d.id, d]));

  const resolved: ResolvedField[] = [];
  // Sorted so a body with several answers validates in a stable order.
  for (const fieldId of Object.keys(answers ?? {}).sort()) {
    const raw = (answers ?? {})[fieldId];
    const def = byId.get(fieldId);
    if (!def) throw new FieldValueError(`Unknown field for this tracker: ${fieldId}`);

    const out: ResolvedField = {
      fieldId,
      set: false,
      option: null,
      number: null,
      text: null,
    };
    if (raw !== null && raw !== undefined) {
      switch (def.kind) {
        case 'choice': {
          if (typeof raw !== 'string') {
            throw new FieldValueError(`Expected an option id for field "${def.name}"`);
          }
          if (raw !== '') {
            if (!def.optionIds.has(raw)) {
              throw new FieldValueError(`Unknown option for field "${def.name}": ${raw}`);
            }
            out.set = true;
            out.option = raw;
          }
          break;
        }
        case 'flag': {
          const value = flagValue(raw);
          if (value === null) {
            throw new FieldValueError(
              `Expected true, false, 0, or 1 for field "${def.name}"`,
            );
          }
          out.set = true;
          out.number = value;
          break;
        }
        case 'number': {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new FieldValueError(`Expected a number for field "${def.name}"`);
          }
          out.set = true;
          out.number = raw;
          break;
        }
        case 'text': {
          if (typeof raw !== 'string') {
            throw new FieldValueError(`Expected text for field "${def.name}"`);
          }
          const trimmed = raw.trim();
          if (trimmed !== '') {
            if (trimmed.length > MAX_FIELD_TEXT_LENGTH) {
              throw new FieldValueError(
                `Field "${def.name}" must contain at most ${MAX_FIELD_TEXT_LENGTH} character(s)`,
              );
            }
            out.set = true;
            out.text = trimmed;
          }
          break;
        }
      }
    }
    resolved.push(out);
  }

  return resolved;
}

/** Coerce a flag answer to 0 or 1, or null if it is neither. */
function flagValue(raw: string | number | boolean): number | null {
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (raw === 0 || raw === 1) return raw;
  return null;
}

/**
 * Persist an entry's answers. Only the fields named in `resolved` are touched,
 * so a patch mentioning one field leaves the entry's other answers alone.
 */
export async function writeEntryFields(
  tx: Storage,
  entryId: string,
  resolved: readonly ResolvedField[],
): Promise<void> {
  for (const r of resolved) {
    await tx.exec(
      `DELETE FROM entry_field_values WHERE entry_id = ? AND field_id = ?`,
      [entryId, r.fieldId],
    );
    if (!r.set) continue;
    await tx.exec(
      `INSERT INTO entry_field_values
         (id, entry_id, field_id, option_id, number_value, text_value)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), entryId, r.fieldId, r.option, r.number, r.text],
    );
  }
}

// --- reading entry answers -------------------------------------------------------

/**
 * Fill in the `fields` of a batch of entries in place — one query for the
 * whole page rather than one per entry.
 */
export async function attachEntryFields(
  storage: Storage,
  entries: Entry[],
): Promise<Entry[]> {
  for (const entry of entries) entry.fields = [];
  const entryIds = [...new Set(entries.map((e) => e.id))];
  if (entryIds.length === 0) return entries;

  const rows = await storage.query<EntryFieldValue>(
    `SELECT v.* FROM entry_field_values v
       JOIN tracker_fields f ON f.id = v.field_id
      WHERE v.entry_id IN (${entryIds.map(() => '?').join(', ')})
      ORDER BY f.sort_order ASC, f.created_at ASC`,
    entryIds as SqlParam[],
  );
  const byEntry = new Map<string, EntryFieldValue[]>();
  for (const row of rows) {
    const list = byEntry.get(row.entry_id) ?? [];
    list.push(row);
    byEntry.set(row.entry_id, list);
  }
  for (const entry of entries) entry.fields = byEntry.get(entry.id) ?? [];
  return entries;
}
