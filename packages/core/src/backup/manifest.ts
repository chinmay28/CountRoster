import { z } from 'zod';

/**
 * Schema of the `manifest.json` inside a .countroster.zip bundle.
 *
 * If the format ever changes incompatibly, bump `format_version` and add a
 * backward-compatible reader that handles old versions.
 */
export const manifestSchema = z.object({
  format_version: z.literal(1),
  app_version: z.string(),
  schema_version: z.number().int().positive(),
  exported_at: z.string().datetime({ offset: true }),
  device_id: z.string().optional(),
  row_counts: z.record(z.string(), z.number().int().nonnegative()),
  checksums: z.object({
    'db.sqlite': z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;
