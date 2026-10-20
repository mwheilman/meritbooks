/**
 * Dealer imports — response shapes of POST /api/dealer/imports/parse and
 * POST /api/dealer/imports/parse/resolve (types only; client-safe).
 */

import type { AiProposal } from './ai-normalize';
import type { ColumnMapping } from './mapping';
import type { Resolution } from './targets';

interface ParseBase {
  batchId: string;
  sourceDocumentId: string | null;
  fileName: string;
}

/** A spreadsheet (or tabular pasted text): map columns — no AI needed. */
export interface ParseMapping extends ParseBase {
  mode: 'mapping';
  sheetName: string | null;
  sheetNames: string[];
  /** 1-based file row of the header the reader picked. */
  headerRow: number;
  headers: string[];
  rows: Record<string, string>[];
  /** 1-based file row of each record (for "row 14" messages). */
  rowNumbers: number[];
  totalRows: number;
  truncated: boolean;
  suggestedMapping: ColumnMapping;
  /** Set when the person asked for AI but it is paused, so we fell back to mapping. */
  aiNotice?: string | null;
}

/** A document the AI read: review the proposal. */
export interface ParseAi extends ParseBase {
  mode: 'ai';
  feature: string;
  model: string;
  decisionId: string | null;
  proposal: AiProposal;
  /** The tenant's autonomy dial imported the statement itself (footing passed). */
  autoImported: { statementId: string; lineCount: number; reason: string } | null;
  autonomyReason: string | null;
}

/** AI can't run right now (paused / budget) — steer to a CSV or Excel export. */
export interface ParseAiUnavailable extends ParseBase {
  mode: 'ai_unavailable';
  unavailable: true;
  code: 'AI_UNAVAILABLE';
  message: string;
}

/** No document reader exists for this kind (e.g. warranty registers as PDF). */
export interface ParseUnsupported extends ParseBase {
  mode: 'unsupported';
  message: string;
}

export type ParseResponse = ParseMapping | ParseAi | ParseAiUnavailable | ParseUnsupported;

export type ResolveResponse = Resolution;

/** Max rows one import reads (D1 statement imports cap at 5000 lines). */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
