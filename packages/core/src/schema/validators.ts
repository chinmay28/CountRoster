import { z } from 'zod';
import type {
  ResetPeriod,
  TrackerFieldKind,
  TrackerKind,
  WeekStart,
} from './tables.js';

/**
 * Zod schemas for *inputs* to the domain layer (create / update DTOs).
 * Reading rows back out is just `as Tracker` etc. — we trust the DB to
 * return shapes that match `tables.ts`.
 */

export const trackerKindSchema: z.ZodType<TrackerKind> = z.enum([
  'count',
  'number',
  'duration',
  'boolean',
  'choice',
]);

export const resetPeriodSchema: z.ZodType<ResetPeriod> = z.enum([
  'never',
  'daily',
  'weekly',
  'monthly',
  'yearly',
]);

export const weekStartSchema: z.ZodType<WeekStart> = z.union([
  z.literal(0),
  z.literal(1),
]);

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a 6-digit hex color like #4ECDC4');

/**
 * A tracker's detail-page section order: a comma-separated list of unique
 * lowercase section keys. The empty string is allowed and reads the same as
 * null — no explicit order.
 */
const sectionOrder = z
  .string()
  .max(400)
  .refine(
    (s) =>
      s === '' ||
      (s.split(',').length <= 20 &&
        s.split(',').every((k, i, all) => /^[a-z][a-z0-9_-]{0,39}$/.test(k) && all.indexOf(k) === i)),
    'expected a comma-separated list of unique section keys like "summary,trends,entries"',
  );

/**
 * One operand of a derived tracker. A coefficient of -1 subtracts the source,
 * +1 adds it, 0.5 takes half of it, etc.
 */
export const trackerLinkInputSchema = z.object({
  source_id: z.string().min(1),
  coefficient: z.number().finite().default(1),
});
export type TrackerLinkInput = z.infer<typeof trackerLinkInputSchema>;

/** Input to TrackerService.create() */
export const trackerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  color: hexColor.default('#888888'),
  icon: z.string().max(60).optional().nullable(),
  kind: trackerKindSchema.default('count'),
  unit: z.string().max(30).optional().nullable(),
  target: z.number().finite().optional().nullable(),
  reset_period: resetPeriodSchema.default('never'),
  week_start: weekStartSchema.default(1),
  day_start_minute: z.number().int().min(0).max(1439).default(0),
  month_start_day: z.number().int().min(1).max(28).default(1),
  year_start_month: z.number().int().min(1).max(12).default(1),
  default_value: z.number().finite().default(1),
  sort_order: z.number().int().default(0),
  /** Hidden trackers are omitted from list() unless `includeHidden` is set. */
  is_hidden: z.union([z.literal(0), z.literal(1)]).default(0),
  /**
   * Snapshot trackers record point-in-time levels (net worth, weight) rather
   * than amounts: aggregations take the latest entry, not a sum. A snapshot
   * tracker has no reset window, so `reset_period` must stay 'never'.
   */
  is_snapshot: z.union([z.literal(0), z.literal(1)]).default(0),
  /**
   * The detail page's section order, as a comma-separated list of section
   * keys. Null (or absent) means the default order. The keys stay opaque to
   * the domain, but the shape is pinned: lowercase slugs, no blanks, no
   * duplicates, at most 20.
   */
  section_order: sectionOrder.optional().nullable(),
  /**
   * When present, the tracker is *derived*: its value is computed from these
   * source trackers rather than logged directly. On update, the supplied list
   * fully replaces the existing links (an empty list makes it ordinary again).
   */
  links: z.array(trackerLinkInputSchema).max(50).optional(),
});

export type TrackerInput = z.infer<typeof trackerInputSchema>;

/** Input to TrackerService.update() — every field optional. */
export const trackerPatchSchema = trackerInputSchema.partial();
export type TrackerPatch = z.infer<typeof trackerPatchSchema>;

export const trackerFieldKindSchema: z.ZodType<TrackerFieldKind> = z.enum([
  'choice',
  'flag',
  'number',
  'text',
]);

/**
 * One alternative of a `choice` field. A supplied `id` names an existing row
 * so rewriting the field set keeps it — and the entry answers pointing at it —
 * rather than replacing it with a fresh one.
 */
export const trackerFieldOptionInputSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().trim().min(1).max(60),
  color: hexColor.optional().nullable(),
});
/**
 * What a caller may *send*. Unlike the tracker/group DTOs this is Zod's input
 * type, not its output — the output marks defaulted fields (`options`)
 * required, which would force every caller to spell out defaults Zod exists
 * to fill in.
 */
export type TrackerFieldOptionInput = z.input<typeof trackerFieldOptionInputSchema>;

/**
 * One field in a replace-the-whole-set write. As with options, a supplied `id`
 * preserves the existing row and everything recorded against it.
 */
export const trackerFieldInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(60),
    kind: trackerFieldKindSchema,
    unit: z.string().max(30).optional().nullable(),
    options: z.array(trackerFieldOptionInputSchema).max(50).default([]),
  })
  // Options only mean something for a choice field, and a choice field with
  // nothing to choose from can never be answered.
  .refine((f) => f.kind !== 'choice' || f.options.length > 0, {
    message: 'A choice field needs at least one option',
    path: ['options'],
  })
  .refine((f) => f.kind === 'choice' || f.options.length === 0, {
    message: 'Only a choice field can carry options',
    path: ['options'],
  });
export type TrackerFieldInput = z.input<typeof trackerFieldInputSchema>;

/** Input to FieldService.replace() — the tracker's whole field set. */
export const trackerFieldsInputSchema = z.array(trackerFieldInputSchema).max(20);
export type TrackerFieldsInput = z.input<typeof trackerFieldsInputSchema>;

/**
 * Custom-field answers on a log or patch: field id → answer. The value stays
 * loose here because interpreting it needs the field's declared kind, which
 * only the DB knows — an option id, a 0|1 flag, a number, a string, or null to
 * clear it. Every field is optional: leaving one blank is always legitimate.
 */
export const entryFieldAnswersSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
);
export type EntryFieldAnswers = z.infer<typeof entryFieldAnswersSchema>;

/** Input to EntryService.log() */
export const entryLogInputSchema = z.object({
  value: z.number().finite().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  fields: entryFieldAnswersSchema.optional(),
});
export type EntryLogInput = z.infer<typeof entryLogInputSchema>;

/**
 * One item of EntryService.logMany() — an entry log targeted at a tracker.
 * `value`/`occurred_at` default exactly like single log() (tracker default /
 * now).
 */
export const entryLogManyItemSchema = entryLogInputSchema.extend({
  tracker_id: z.string().min(1),
});
export type EntryLogManyItem = z.infer<typeof entryLogManyItemSchema>;

/**
 * Input to EntryService.logMany(). Capped well under SQLite's bound-parameter
 * limit so the returning SELECT ... IN (...) stays a single statement.
 */
export const entryLogManyInputSchema = z
  .array(entryLogManyItemSchema)
  .min(1)
  .max(500);
export type EntryLogManyInput = z.infer<typeof entryLogManyInputSchema>;

export const entryPatchSchema = z.object({
  value: z.number().finite().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  /** Only the fields named here are rewritten; the rest are left alone. */
  fields: entryFieldAnswersSchema.optional(),
});
export type EntryPatch = z.infer<typeof entryPatchSchema>;

/** Input to NoteService.create() */
export const noteInputSchema = z.object({
  tracker_id: z.string().min(1),
  entry_id: z.string().optional().nullable(),
  body: z.string().max(100_000),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export type NoteInput = z.infer<typeof noteInputSchema>;

/** Input to NoteService.update() — body and/or occurred_at. */
export const notePatchSchema = z.object({
  body: z.string().max(100_000).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export type NotePatch = z.infer<typeof notePatchSchema>;

/** One parsed CSV row for TransactionService.import(). */
export const transactionImportItemSchema = z.object({
  /** Plain calendar date, e.g. "2026-07-04". */
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date like 2026-07-04'),
  description: z.string().trim().min(1).max(500),
  amount: z.number().finite(),
  account: z.string().trim().max(120).optional().nullable(),
  category: z.string().trim().max(120).optional().nullable(),
});
export type TransactionImportItem = z.infer<typeof transactionImportItemSchema>;

/** Input to TransactionService.import(). */
export const transactionImportSchema = z.object({
  transactions: z.array(transactionImportItemSchema).min(1).max(5000),
});
export type TransactionImportInput = z.infer<typeof transactionImportSchema>;

/** Input to TransactionService.update() — pending transactions only. */
export const transactionPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  tracker_id: z.string().min(1).optional().nullable(),
  amount: z.number().finite().optional(),
  posted_at: z.string().datetime({ offset: true }).optional(),
});
export type TransactionPatch = z.infer<typeof transactionPatchSchema>;

/**
 * Input to TransactionService.confirm(): tracker override (falls back to the
 * stored suggestion) and entry-value override (defaults to -amount).
 */
export const transactionConfirmSchema = z.object({
  tracker_id: z.string().min(1).optional(),
  value: z.number().finite().optional(),
});
export type TransactionConfirmInput = z.infer<typeof transactionConfirmSchema>;

/** Input to GroupService.create() */
export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: hexColor.optional().nullable(),
  sort_order: z.number().int().default(0),
});
export type GroupInput = z.infer<typeof groupInputSchema>;

/** Input to GroupService.update() — every field optional. */
export const groupPatchSchema = groupInputSchema.partial();
export type GroupPatch = z.infer<typeof groupPatchSchema>;
