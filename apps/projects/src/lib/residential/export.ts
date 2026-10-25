/**
 * Full data export (RES-127): every object family the caller can read, streamed as NDJSON (one
 * header line, then one line per row tagged with its table) or one table as CSV. The table list
 * comes from pm.res_export_tables() (the access registry; masked views for money tables), and
 * every read runs on the caller's RLS client — an export never shows more than the screens do.
 * Files and photos are listed with their document ids; the documents route serves the bytes.
 * Pure helpers here; the route does the I/O.
 */

export interface ExportTable {
  schema: 'pm';
  table: string;
  source: string;
  class: string;
  scope: string;
  parent_table: string | null;
  parent_column: string | null;
}

export const EXPORT_PAGE = 1000;
export const EXPORT_MAX_ROWS_PER_TABLE = 200_000;

/** Tables to export for one job: every job-keyed family (class J / M) plus the company's catalog (S / C). */
export function exportPlan(tables: ReadonlyArray<ExportTable>, scope: 'company' | 'job'): ExportTable[] {
  const byName = new Map(tables.map((t) => [t.source, t]));
  const rootClass = (t: ExportTable): string => {
    let cur: ExportTable | undefined = t;
    for (let i = 0; i < 5 && cur && cur.scope === 'parent' && cur.parent_table; i++) cur = byName.get(cur.parent_table);
    return cur?.class ?? t.class;
  };
  const out = scope === 'job' ? tables.filter((t) => ['J', 'M'].includes(rootClass(t))) : [...tables];
  // parents before children (a child row is exported under the parent ids already written)
  const depth = (t: ExportTable): number => {
    let d = 0; let cur: ExportTable | undefined = t;
    while (cur && cur.scope === 'parent' && cur.parent_table && d < 5) { d++; cur = byName.get(cur.parent_table); }
    return d;
  };
  return out.sort((a, b) => depth(a) - depth(b) || a.source.localeCompare(b.source));
}

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV with the union of keys as the header (stable order: first-seen). */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function ndjsonLine(table: string, row: unknown): string {
  return `${JSON.stringify({ table, row })}\n`;
}

export function exportFileName(kind: 'ndjson' | 'csv', label: string, today: string): string {
  const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'export';
  return `merit-projects-${safe}-${today}.${kind === 'csv' ? 'csv' : 'ndjson'}`;
}
