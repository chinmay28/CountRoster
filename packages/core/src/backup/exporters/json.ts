import type { Manifest } from '../manifest.js';

export interface AllJson {
  manifest: Manifest;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Whole-database JSON dump: the manifest plus every table's rows. This is the
 * primary restorable artifact (see manifest checksum), so its serialization
 * must be stable — keys are emitted in insertion order, which the dumper
 * controls via BACKUP_TABLES.
 */
export function dumpAllJSON(
  manifest: Manifest,
  tables: Record<string, Array<Record<string, unknown>>>,
): string {
  const doc: AllJson = { manifest, tables };
  return JSON.stringify(doc, null, 2);
}

export function parseAllJSON(text: string): AllJson {
  const doc = JSON.parse(text) as AllJson;
  if (!doc || typeof doc !== 'object' || !doc.manifest || !doc.tables) {
    throw new Error('Invalid all.json: missing manifest or tables');
  }
  return doc;
}
