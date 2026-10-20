/**
 * Dealer imports — assemble a whole lender / manufacturer statement from its header and
 * lines, with D1's footing rule applied (pure, client-safe). Used by the review screen
 * (live footing check, submit) AND by the parse route's autonomy path, so both refuse
 * the same statements: lines that don't add up to the statement totals never import.
 */

import type { FootingResult } from '../engine/statement-match';
import type { StatementKind } from '../types';
import { footLender, footOem, type OemFooting } from './mapping';
import {
  checkLenderHeader,
  checkOemHeader,
  validateRows,
  type Cells,
  type ImportContext,
  type LenderHeaderInput,
  type LenderLine,
  type LenderStatementBody,
  type OemHeaderInput,
  type OemLine,
  type OemStatementBody,
  type RowsCheck,
} from './targets';

export const FOOTING_MESSAGE = 'The lines must add up to the statement totals';

export interface LenderAssembly {
  ok: boolean;
  /** Plain-English reasons it can't import yet. */
  problems: string[];
  rows: RowsCheck;
  footing: FootingResult | null;
  body: LenderStatementBody | null;
}

export function assembleLenderStatement(
  header: LenderHeaderInput,
  rows: Cells[],
  ctx: ImportContext & { documentId?: string | null },
): LenderAssembly {
  const problems: string[] = [];
  if (!ctx.lineId) problems.push('Choose the floor-plan line this statement is for.');
  const check = validateRows(ctx.kind, rows, ctx);
  if (check.rejected > 0) problems.push(`${check.rejected} line${check.rejected === 1 ? '' : 's'} still ${check.rejected === 1 ? 'has' : 'have'} a problem.`);
  if (rows.length === 0) problems.push('The statement has no lines.');
  const h = checkLenderHeader(header);
  if (!h.ok) problems.push(...h.errors);
  const lines: LenderLine[] = check.results.flatMap((r) => (r.ok && r.plan.target === 'lenderLine' ? [r.plan.line] : []));
  let footing: FootingResult | null = null;
  if (h.ok) {
    footing = footLender(lines, h.value.footer);
    if (check.rejected === 0 && !footing.ok) problems.push(`${FOOTING_MESSAGE}: ${footing.problems.join(' ')}`);
  }
  const ok = problems.length === 0 && h.ok && !!footing?.ok;
  return {
    ok,
    problems,
    rows: check,
    footing,
    body:
      ok && h.ok
        ? {
            lineId: ctx.lineId!,
            kind: h.value.kind as StatementKind,
            statementDate: h.value.statementDate,
            documentId: ctx.documentId ?? null,
            importBatchId: ctx.importBatchId,
            footer: h.value.footer,
            lines,
          }
        : null,
  };
}

export interface OemAssembly {
  ok: boolean;
  problems: string[];
  rows: RowsCheck;
  footing: OemFooting | null;
  body: OemStatementBody | null;
}

export function assembleOemStatement(
  header: OemHeaderInput,
  rows: Cells[],
  ctx: ImportContext & { documentId?: string | null },
): OemAssembly {
  const problems: string[] = [];
  if (!ctx.oemVendorId) problems.push('Choose the manufacturer this statement is from.');
  const check = validateRows('OEM_STATEMENT', rows, ctx);
  if (check.rejected > 0) problems.push(`${check.rejected} line${check.rejected === 1 ? '' : 's'} still ${check.rejected === 1 ? 'has' : 'have'} a problem.`);
  if (rows.length === 0) problems.push('The statement has no lines.');
  const h = checkOemHeader(header);
  if (!h.ok) problems.push(...h.errors);
  const lines: OemLine[] = check.results.flatMap((r) => (r.ok && r.plan.target === 'oemLine' ? [r.plan.line] : []));
  let footing: OemFooting | null = null;
  if (h.ok) {
    footing = footOem(lines, h.value.footerTotalCents);
    if (check.rejected === 0 && !footing.ok) {
      problems.push(`${FOOTING_MESSAGE}: the lines total ${dollars(footing.sumCents)} but the statement says ${dollars(h.value.footerTotalCents)}.`);
    }
  }
  const ok = problems.length === 0 && h.ok && !!footing?.ok;
  return {
    ok,
    problems,
    rows: check,
    footing,
    body:
      ok && h.ok
        ? {
            oemVendorId: ctx.oemVendorId!,
            statementDate: h.value.statementDate,
            documentId: ctx.documentId ?? null,
            importBatchId: ctx.importBatchId,
            footerTotalCents: h.value.footerTotalCents,
            lines,
          }
        : null,
  };
}

function dollars(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Header text for a lender statement from an AI proposal / footer suggestion. */
export function lenderHeaderFrom(h: Record<string, string>, fallbackKind: StatementKind): LenderHeaderInput {
  const k = h.statementKind;
  return {
    statementKind: k === 'STATEMENT' || k === 'AUDIT' || k === 'PAYOFF_QUOTE' ? k : fallbackKind,
    statementDate: h.statementDate ?? '',
    footerPrincipal: h.footerPrincipal ?? '',
    footerInterest: h.footerInterest ?? '',
    footerFees: h.footerFees ?? '',
    footerLineCount: h.footerLineCount ?? '',
  };
}

export function oemHeaderFrom(h: Record<string, string>): OemHeaderInput {
  return { statementDate: h.statementDate ?? '', footerTotal: h.footerTotal ?? '' };
}
