import { z } from 'zod';
import type { ResetPeriod, TrackerKind, WeekStart } from './tables.js';

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
  default_value: z.number().finite().default(1),
  sort_order: z.number().int().default(0),
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

/** Input to EntryService.log() */
export const entryLogInputSchema = z.object({
  value: z.number().finite().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export type EntryLogInput = z.infer<typeof entryLogInputSchema>;

export const entryPatchSchema = z.object({
  value: z.number().finite().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
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

/** Input to ReminderService.create() */
export const reminderInputSchema = z.object({
  tracker_id: z.string().min(1),
  time_minute: z.number().int().min(0).max(1439),
  days_mask: z.number().int().min(0).max(127).default(127),
  enabled: z.union([z.literal(0), z.literal(1)]).default(1),
});
export type ReminderInput = z.infer<typeof reminderInputSchema>;

/** Input to ReminderService.update() — tracker_id is immutable, so omitted. */
export const reminderPatchSchema = reminderInputSchema
  .omit({ tracker_id: true })
  .partial();
export type ReminderPatch = z.infer<typeof reminderPatchSchema>;
