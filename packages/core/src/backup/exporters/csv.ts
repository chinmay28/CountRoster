/**
 * Minimal RFC-4180 CSV writer. No dependency needed — the quoting rules are
 * straightforward: wrap a field in double quotes when it contains a comma,
 * quote, CR, or LF, and double any embedded quotes.
 */

type CsvValue = string | number | null | Uint8Array;

function encodeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) {
    // Binary blobs aren't expected in this schema, but encode defensively.
    let hex = '';
    for (const b of value) hex += b.toString(16).padStart(2, '0');
    value = `\\x${hex}`;
  }
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Render rows to a CSV string with the given column order as the header. */
export function rowsToCSV(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [columns.map(encodeField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => encodeField(row[c] ?? null)).join(','));
  }
  return lines.join('\r\n');
}
