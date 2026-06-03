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
    // SHA-256 of the canonical serialization of the `tables` payload — the
    // primary restorable artifact. (The SQL Storage contract has no raw-file
    // access, so the table dump, not a `db.sqlite` blob, is what we checksum
    // and restore. It excludes the manifest itself to avoid a circular hash.)
    tables: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;
