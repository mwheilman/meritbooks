/**
 * The import engine pipeline (PLT-67): file → grid → header row → table → source detection →
 * deterministic mapping (+ optional AI guesses for leftovers) → typed, validated rows → preview
 * with the 0–3 columns worth a look and a validation report. Pure (inflate injected for .xlsx,
 * file hash computed by the caller), so the preview the user confirms is exactly what is staged.
 */
import { gridToTable, type Grid } from '../onboarding/import/grid';
import { gridFromUpload } from '../onboarding/import/parse';
import type { InflateRaw } from '../onboarding/import/xlsx';
import { dispositionOf, ENTITY_DEFS } from './fields';
import { detectSource, findHeaderRow, headerSignature, mapColumns, unmappedHeaders, unsureColumns } from './mapping';
import { normalizeRecords, validationReport } from './normalize';
import type { AiOutcome, ColumnMap, ImportEntity, JobTypeChoice, PreviewResult, SavedMapping, SourceSystem } from './types';

export const MAX_IMPORT_ROWS = 5000;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface UploadTable {
  fileName: string;
  headers: string[];
  headerRow: number;
  records: Record<string, string>[];
  rowNumbers: number[];
  rowCount: number;
  truncated: boolean;
}

export type Failure = { ok: false; message: string };

export function tableFromGrid(grid: Grid, fileName: string): UploadTable | Failure {
  const headerIdx = findHeaderRow(grid);
  const { headers, rows, rowNumbers } = gridToTable(grid, headerIdx);
  if (headers.length === 0 || rows.length === 0) return { ok: false, message: 'We found column headers but no rows under them. Check the export includes the data rows.' };
  return {
    fileName, headers, headerRow: headerIdx + 1,
    records: rows.slice(0, MAX_IMPORT_ROWS), rowNumbers: rowNumbers.slice(0, MAX_IMPORT_ROWS),
    rowCount: rows.length, truncated: rows.length > MAX_IMPORT_ROWS,
  };
}

/** Bytes of an uploaded CSV / .xlsx → a header-keyed table, or a plain-words failure. */
export function readUpload(fileName: string, mime: string | null, bytes: Uint8Array, inflate: InflateRaw): UploadTable | Failure {
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, message: 'That file is over 8 MB. Split it (open work only helps) and drop it again.' };
  const grid = gridFromUpload(fileName, mime, bytes, inflate);
  if (!Array.isArray(grid)) return { ok: false, message: grid.message.replace(/job list/g, 'export') };
  return tableFromGrid(grid, fileName);
}

export function isFailure(x: unknown): x is Failure {
  return typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;
}

export function sampleOf(table: UploadTable, n = 25): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of table.headers) out[h] = table.records.slice(0, n).map((r) => r[h] ?? '');
  return out;
}

export interface PreviewOptions {
  fileHash: string;
  /** the tile the user picked / an explicit choice */
  source?: SourceSystem | null;
  entity?: ImportEntity | null;
  saved?: SavedMapping[];
  overrides?: Record<string, string | null>;
  ai?: { outcome: AiOutcome; mapping: ColumnMap; message: string | null };
  jobTypes: JobTypeChoice[];
  openOnly?: boolean;
}

/** Detection + the first, rules-only mapping (to ask the AI hook about what is left). */
export function firstPass(table: UploadTable, opts: Pick<PreviewOptions, 'source' | 'entity' | 'saved' | 'overrides'>) {
  const detection = detectSource(table.headers, table.fileName, { source: opts.source ?? null, entity: opts.entity ?? null });
  const source = opts.source ?? detection.source;
  const entity = opts.entity ?? detection.entity;
  const saved = (opts.saved ?? []).find((s) => s.source_system === source && s.entity === entity) ?? null;
  const mapping = mapColumns({ entity, source, headers: table.headers, sample: sampleOf(table), saved, overrides: opts.overrides });
  const fields = ENTITY_DEFS[entity].fields.map((f) => f.key).filter((k) => !mapping[k] && opts.overrides?.[k] !== null);
  return { detection, source, entity, saved, mapping, unmappedFields: fields, unmappedHeaders: unmappedHeaders(table.headers, mapping) };
}

export function buildPreview(table: UploadTable, opts: PreviewOptions): PreviewResult {
  const fp = firstPass(table, opts);
  const sample = sampleOf(table);
  const mapping = opts.ai && Object.keys(opts.ai.mapping).length
    ? mapColumns({ entity: fp.entity, source: fp.source, headers: table.headers, sample, saved: fp.saved, overrides: opts.overrides, ai: opts.ai.mapping })
    : fp.mapping;
  const rows = normalizeRecords(table.records, table.rowNumbers, mapping, { entity: fp.entity, jobTypes: opts.jobTypes, openOnly: opts.openOnly ?? true });
  const aiMapped = Object.values(mapping).filter((m) => m.source === 'ai').length;
  return {
    fileName: table.fileName,
    fileHash: opts.fileHash,
    detection: fp.detection,
    source: fp.source,
    entity: fp.entity,
    disposition: dispositionOf(fp.entity),
    headers: table.headers,
    headerRow: table.headerRow,
    rowCount: table.rowCount,
    truncated: table.truncated,
    mapping,
    headerSignature: headerSignature(table.headers),
    unsure: unsureColumns(fp.entity, mapping, sample),
    unmappedHeaders: unmappedHeaders(table.headers, mapping),
    rows,
    report: validationReport(fp.entity, rows),
    ai: { outcome: opts.ai?.outcome ?? 'skipped', mapped: aiMapped, message: opts.ai?.message ?? null },
  };
}

/** The rows pm.import_stage receives. */
export function stagePayload(p: PreviewResult) {
  return p.rows.map((r) => ({ row_number: r.row_number, external_ref: r.external_ref, data: r.data, issues: r.issues, validation: r.validation }));
}
