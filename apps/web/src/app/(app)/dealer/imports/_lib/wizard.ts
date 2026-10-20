'use client';

/** Shared state shapes for the import wizard (client-only, no I/O). */

import type { ImportFileKind, StatementKind, UnitCondition } from '@/lib/dealer/types';
import type { Cells, ImportContext, OemLineType } from '@/lib/dealer/imports/targets';
import { isLenderKind } from '@/lib/dealer/imports/fields';

export interface Setup {
  kind: ImportFileKind | null;
  sourceSystem: string;
  lineId: string | null;
  programId: string | null;
  oemVendorId: string | null;
  retailRebateProgramId: string | null;
  defaultCondition: UnitCondition;
  defaultOemLineType: OemLineType | '';
}

export const EMPTY_SETUP: Setup = {
  kind: null,
  sourceSystem: '',
  lineId: null,
  programId: null,
  oemVendorId: null,
  retailRebateProgramId: null,
  defaultCondition: 'NEW',
  defaultOemLineType: '',
};

/** One row on the review screen (from a mapped spreadsheet row or an AI proposal). */
export interface ReviewRow {
  id: string;
  /** 1-based file row, when it came from a spreadsheet. */
  sourceRow: number | null;
  cells: Cells;
  /** AI confidence 0..1 (null for spreadsheet rows). */
  confidence: number | null;
  lowConfidence: boolean;
  alwaysReview: string[];
  /** Left out of the import (e.g. a totals row, or the person unticked it). */
  excluded: boolean;
  excludedReason?: string;
}

export function defaultStatementKind(kind: ImportFileKind): StatementKind {
  return kind === 'LENDER_AUDIT' ? 'AUDIT' : 'STATEMENT';
}

export function emptyHeader(kind: ImportFileKind): Record<string, string> {
  if (isLenderKind(kind)) {
    return { statementKind: defaultStatementKind(kind), statementDate: '', footerPrincipal: '', footerInterest: '', footerFees: '', footerLineCount: '' };
  }
  if (kind === 'OEM_STATEMENT') return { statementDate: '', footerTotal: '' };
  return {};
}

export function contextFor(setup: Setup, batchId: string | null): ImportContext {
  return {
    kind: setup.kind ?? 'UNITS',
    importBatchId: batchId,
    lineId: setup.lineId,
    programId: setup.programId,
    oemVendorId: setup.oemVendorId,
    retailRebateProgramId: setup.retailRebateProgramId,
    defaultCondition: setup.defaultCondition,
    defaultOemLineType: setup.defaultOemLineType || null,
  };
}

/** What the person must pick in step 1 before uploading. */
export function setupProblems(s: Setup): string[] {
  const p: string[] = [];
  if (!s.kind) p.push('Choose what you are importing.');
  if (s.kind && isLenderKind(s.kind) && !s.lineId) p.push('Choose the floor-plan line this statement is for.');
  if ((s.kind === 'OEM_STATEMENT' || s.kind === 'WARRANTY' || s.kind === 'PROGRAMS') && !s.oemVendorId) p.push('Choose the manufacturer.');
  return p;
}
