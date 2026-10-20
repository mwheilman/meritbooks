/**
 * Dealer imports — server-side helpers for the parse route (SERVER-ONLY: exceljs, the
 * dealer service layer, the autonomy reads). Never import from a client component.
 */

import { readXlsxSheets } from '@/lib/import/spreadsheet-xlsx';
import { gridToTable, readCsvGrid, type Grid } from '@/lib/import/spreadsheet';
import { decideDisposition, loadAutonomyGovernance } from '@/lib/autonomy/disposition';
import { DEALER_PERMS, requireAlso, type DealerCtx } from '../service/context';
import { importLenderStatement, importOemStatement } from '../service/statements';
import { updateImportBatch } from '../service/imports';
import type { ImportFileKind, StatementKind } from '../types';
import type { AiProposal } from './ai-normalize';
import { detectHeaderRow, pickSheet, suggestMapping, textToGrid } from './mapping';
import { MAX_IMPORT_ROWS, type ParseMapping } from './protocol';
import { assembleLenderStatement, assembleOemStatement, lenderHeaderFrom, oemHeaderFrom } from './statements';
import { isLenderKind } from './fields';

/** Confidence (0..1) at or above which a footing statement counts as an "exact" read. */
export const AUTO_IMPORT_MIN_CONFIDENCE = 0.95;

export type FileClass = 'xlsx' | 'csv' | 'pdf' | 'image' | 'text' | 'xls' | null;

export function classifyUpload(name: string, mime: string): FileClass {
  const n = name.toLowerCase();
  const m = mime.toLowerCase();
  // Extension first: browsers often send a blank or wrong MIME (a .csv as ms-excel).
  if (n.endsWith('.xlsx') || n.endsWith('.xlsm')) return 'xlsx';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.xls')) return 'xls';
  if (n.endsWith('.tsv') || n.endsWith('.txt') || n.endsWith('.eml')) return 'text';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(jpe?g|png|gif|webp)$/.test(n)) return 'image';
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (m === 'text/csv') return 'csv';
  if (m === 'application/vnd.ms-excel') return 'xls';
  if (m === 'text/plain' || m === 'text/tab-separated-values') return 'text';
  if (m === 'application/pdf') return 'pdf';
  if (/^image\/(jpeg|png|gif|webp)$/.test(m)) return 'image';
  return null;
}

/** The canonical MIME for a classified upload (the Documents store only accepts known types). */
export function mimeFor(c: Exclude<FileClass, null>, given: string, name: string): string {
  switch (c) {
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls': return 'application/vnd.ms-excel';
    case 'csv': return 'text/csv';
    case 'text': return 'text/plain';
    case 'pdf': return 'application/pdf';
    case 'image': {
      if (/^image\/(jpeg|png|gif|webp)$/.test(given)) return given;
      const n = name.toLowerCase();
      return n.endsWith('.png') ? 'image/png' : n.endsWith('.gif') ? 'image/gif' : n.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    }
  }
}

/** Read a spreadsheet / tabular text into the mapping payload (no AI). */
export async function readForMapping(
  kind: ImportFileKind,
  input: { cls: 'xlsx' | 'csv' | 'text'; bytes?: ArrayBuffer; text?: string },
): Promise<Omit<ParseMapping, 'batchId' | 'sourceDocumentId' | 'fileName' | 'mode'>> {
  let sheets: Array<{ name: string; grid: Grid }>;
  if (input.cls === 'xlsx') sheets = await readXlsxSheets(input.bytes!);
  else if (input.cls === 'csv') sheets = [{ name: 'CSV', grid: readCsvGrid(input.text ?? '') }];
  else sheets = [{ name: 'Text', grid: textToGrid(input.text ?? '') }];
  sheets = sheets.filter((s) => s.grid.some((r) => r.length > 0));
  if (sheets.length === 0) throw new Error('That file has no rows we can read.');
  const idx = pickSheet(kind, sheets);
  const sheet = sheets[idx];
  const headerIdx = detectHeaderRow(sheet.grid, kind);
  const table = gridToTable(sheet.grid, headerIdx);
  const truncated = table.rows.length > MAX_IMPORT_ROWS;
  return {
    sheetName: input.cls === 'xlsx' ? sheet.name : null,
    sheetNames: input.cls === 'xlsx' ? sheets.map((s) => s.name) : [],
    headerRow: headerIdx + 1,
    headers: table.headers,
    rows: table.rows.slice(0, MAX_IMPORT_ROWS),
    rowNumbers: table.rowNumbers.slice(0, MAX_IMPORT_ROWS),
    totalRows: table.rows.length,
    truncated,
    suggestedMapping: suggestMapping(kind, table.headers),
  };
}

/** Spreadsheet → plain text for the AI reader (when a person asks AI to read a messy sheet). */
export async function spreadsheetToText(cls: 'xlsx' | 'csv', bytes: ArrayBuffer): Promise<string> {
  if (cls === 'csv') return new TextDecoder().decode(bytes);
  const sheets = await readXlsxSheets(bytes);
  return sheets.map((s) => `# Sheet: ${s.name}\n${s.grid.map((r) => r.join('\t')).join('\n')}`).join('\n\n');
}

const NO_PERM = 'Automatic import needs permission to record statements — left for review.';

/** The statement routes require DEALER_PERMS.edit; the autonomy path holds the same bar. */
async function mayCreate(d: DealerCtx): Promise<boolean> {
  try {
    await requireAlso(d, DEALER_PERMS.edit, '/api/dealer/imports/parse');
    return true;
  } catch {
    return false;
  }
}

export interface AutoImportOutcome {
  imported: { statementId: string; lineCount: number; reason: string } | null;
  reason: string | null;
}

/**
 * FPB A1/A2 dial: "auto-import when footing passes". Only when the tenant raised the
 * feature to AUTO_UNDER_LIMIT, every line validated, the statement FOOTS, the read was
 * confident (no low-confidence line, mean ≥ 95%) and the total is under the cap. It only
 * creates the statement record (D1 import) — matching and sign-off stay human. Never
 * touches the GL.
 */
export async function maybeAutoImportStatement(
  d: DealerCtx,
  args: { kind: ImportFileKind; feature: string; proposal: AiProposal; lineId: string | null; oemVendorId: string | null; batchId: string; documentId: string | null },
): Promise<AutoImportOutcome> {
  const { kind, proposal } = args;
  if (!isLenderKind(kind) && kind !== 'OEM_STATEMENT') return { imported: null, reason: null };
  const ctx = { kind, importBatchId: args.batchId, lineId: args.lineId, oemVendorId: args.oemVendorId, documentId: args.documentId };
  const cells = proposal.rows.map((r) => r.cells);
  const confident = proposal.rows.length > 0 && proposal.rows.every((r) => !r.lowConfidence) && proposal.confidence >= AUTO_IMPORT_MIN_CONFIDENCE;

  const gov = await loadAutonomyGovernance(d.db, d.orgId, args.feature);
  if (isLenderKind(kind)) {
    const a = assembleLenderStatement(lenderHeaderFrom(proposal.header, kind === 'LENDER_AUDIT' ? 'AUDIT' : ('STATEMENT' as StatementKind)), cells, ctx);
    const decision = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: a.ok && confident ? 'auto' : 'review',
      amountCents: a.body?.footer.principalCents ?? null,
    });
    if (decision.disposition !== 'AUTO' || !a.body) return { imported: null, reason: decision.reason };
    if (!(await mayCreate(d))) return { imported: null, reason: NO_PERM };
    const res = await importLenderStatement(d, a.body);
    await updateImportBatch(d, args.batchId, { status: 'PROPOSED', rowCount: cells.length, acceptedCount: res.lineCount, rejectedCount: 0, errors: [] });
    return { imported: { statementId: res.statement.id, lineCount: res.lineCount, reason: decision.reason }, reason: decision.reason };
  }
  const a = assembleOemStatement(oemHeaderFrom(proposal.header), cells, ctx);
  const decision = decideDisposition({
    killSwitchEngaged: gov.killSwitchEngaged,
    setting: gov.setting,
    scoreTier: a.ok && confident ? 'auto' : 'review',
    amountCents: a.body ? Math.abs(a.body.footerTotalCents) : null,
  });
  if (decision.disposition !== 'AUTO' || !a.body) return { imported: null, reason: decision.reason };
  if (!(await mayCreate(d))) return { imported: null, reason: NO_PERM };
  const res = await importOemStatement(d, a.body);
  await updateImportBatch(d, args.batchId, { status: 'PROPOSED', rowCount: cells.length, acceptedCount: res.lineCount, rejectedCount: 0, errors: [] });
  return { imported: { statementId: res.id, lineCount: res.lineCount, reason: decision.reason }, reason: decision.reason };
}
