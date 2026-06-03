import type { Storage } from '../storage/adapter.js';
import type { Clock } from '../time.js';
import { manifestSchema, type Manifest } from './manifest.js';
import { BACKUP_TABLES } from './tables.js';
import { rowsToCSV } from './exporters/csv.js';
import { dumpAllJSON, parseAllJSON } from './exporters/json.js';
import { zipStore, unzip, type ZipEntry } from './zip.js';

const SCHEMA_VERSION_KEY = 'schema_version';
const FORMAT_VERSION = 1 as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ImportOptions {
  /** If false, refuse to import when the local DB already holds trackers. */
  confirmOverwrite?: boolean;
}

export interface ImportResult {
  imported_rows: Record<string, number>;
  schema_version: number;
}

export interface BackupService {
  /** Build (but don't write) the manifest describing the current DB. */
  buildManifest(opts: { app_version: string }): Promise<Manifest>;

  /** Produce the full .countroster.zip (manifest + per-table CSVs + all.json). */
  exportBundle(opts?: { app_version: string }): Promise<Uint8Array>;

  /** Replace the current DB contents with the rows from a bundle. */
  importBundle(bytes: Uint8Array, opts?: ImportOptions): Promise<ImportResult>;
}

export function createBackupService(
  storage: Storage,
  clock: Clock,
): BackupService {
  return new BackupServiceImpl(storage, clock);
}

class BackupServiceImpl implements BackupService {
  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
  ) {}

  private async readAllTables(): Promise<
    Record<string, Array<Record<string, unknown>>>
  > {
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const { name } of BACKUP_TABLES) {
      tables[name] = await this.storage.query<Record<string, unknown>>(
        `SELECT * FROM ${name}`,
      );
    }
    return tables;
  }

  private async schemaVersion(): Promise<number> {
    const rows = await this.storage.query<{ value: string }>(
      `SELECT value FROM app_meta WHERE key = ?`,
      [SCHEMA_VERSION_KEY],
    );
    return rows.length > 0 ? Number.parseInt(rows[0]!.value, 10) : 0;
  }

  async buildManifest(opts: { app_version: string }): Promise<Manifest> {
    const tables = await this.readAllTables();
    return this.manifestFor(tables, opts.app_version);
  }

  private async manifestFor(
    tables: Record<string, Array<Record<string, unknown>>>,
    appVersion: string,
  ): Promise<Manifest> {
    const row_counts: Record<string, number> = {};
    for (const { name } of BACKUP_TABLES) {
      row_counts[name] = tables[name]?.length ?? 0;
    }
    return {
      format_version: FORMAT_VERSION,
      app_version: appVersion,
      schema_version: await this.schemaVersion(),
      exported_at: this.clock.nowISO(),
      row_counts,
      checksums: { tables: await checksumTables(tables) },
    };
  }

  async exportBundle(opts?: { app_version: string }): Promise<Uint8Array> {
    const tables = await this.readAllTables();
    const manifest = await this.manifestFor(tables, opts?.app_version ?? '0.0.0');

    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) },
      { name: 'all.json', data: encoder.encode(dumpAllJSON(manifest, tables)) },
    ];
    for (const { name, columns } of BACKUP_TABLES) {
      entries.push({
        name: `exports/${name}.csv`,
        data: encoder.encode(rowsToCSV(columns, tables[name] ?? [])),
      });
    }
    return zipStore(entries);
  }

  async importBundle(
    bytes: Uint8Array,
    opts: ImportOptions = {},
  ): Promise<ImportResult> {
    const files = unzip(bytes);
    const allJson = files.get('all.json');
    if (!allJson) throw new Error('Invalid bundle: all.json is missing');

    const doc = parseAllJSON(decoder.decode(allJson));
    const manifest = manifestSchema.parse(doc.manifest);

    if (manifest.format_version !== FORMAT_VERSION) {
      throw new Error(
        `Unsupported bundle format_version ${manifest.format_version}`,
      );
    }
    const current = await this.schemaVersion();
    if (manifest.schema_version > current) {
      throw new Error(
        `Bundle schema_version ${manifest.schema_version} is newer than this ` +
          `app (${current}); upgrade the app to restore it.`,
      );
    }

    const expected = manifest.checksums.tables;
    const actual = await checksumTables(doc.tables);
    if (actual !== expected) {
      throw new Error('Bundle integrity check failed: tables checksum mismatch');
    }

    if (!opts.confirmOverwrite) {
      const existing = await this.storage.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM trackers`,
      );
      if ((existing[0]?.n ?? 0) > 0) {
        throw new Error(
          'Refusing to overwrite a non-empty database; pass confirmOverwrite.',
        );
      }
    }

    const imported_rows: Record<string, number> = {};
    await this.storage.transaction(async (tx) => {
      // Delete children before parents.
      for (let i = BACKUP_TABLES.length - 1; i >= 0; i--) {
        await tx.exec(`DELETE FROM ${BACKUP_TABLES[i]!.name}`);
      }
      // Insert parents before children.
      for (const { name, columns } of BACKUP_TABLES) {
        const rows = doc.tables[name] ?? [];
        const placeholders = columns.map(() => '?').join(', ');
        const sql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`;
        for (const row of rows) {
          await tx.exec(
            sql,
            columns.map((c) => normalizeParam(row[c])),
          );
        }
        imported_rows[name] = rows.length;
      }
    });

    return { imported_rows, schema_version: manifest.schema_version };
  }
}

/** Coerce a JSON-parsed value into a SQL-bindable param. */
function normalizeParam(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

/** SHA-256 (hex) of the canonical serialization of the tables payload. */
async function checksumTables(
  tables: Record<string, Array<Record<string, unknown>>>,
): Promise<string> {
  // Canonical: emit tables in BACKUP_TABLES order so the hash is stable.
  const ordered: Record<string, unknown> = {};
  for (const { name } of BACKUP_TABLES) ordered[name] = tables[name] ?? [];
  const bytes = encoder.encode(JSON.stringify(ordered));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}
