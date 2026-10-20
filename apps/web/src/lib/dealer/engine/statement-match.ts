/**
 * Lender statement / floor-check reconciliation (FPB §3.10) — pure.
 *
 * 1. A statement must FOOT (lines sum to the footer) before matching starts — a parser
 *    or import that doesn't foot is rejected outright.
 * 2. Each line is paired to a live note by lender invoice #, then serial, then
 *    model + original amount; labelled MATCHED (balance agrees), VARIANCE (balance
 *    differs; overTolerance flags DL-8) or LENDER_ONLY. Live notes on the line that no
 *    statement line claims are BOOKS_ONLY (STATEMENT / AUDIT only).
 * 3. A line whose lender code is one of the line's sold-and-unpaid codes, matched to a
 *    note Books still shows unsold, is a Books error → task RECORD_SALE.
 * 4. Prepare requires every VARIANCE over tolerance / LENDER_ONLY / BOOKS_ONLY line to be
 *    RESOLVED; approve requires a different person than the preparer (DB CHECK too).
 */

import { DealerEngineError, type NoteStatus, type StatementKind, type StatementMatchMethod, type StatementMatchStatus } from '../types';

export interface StatementLineIn {
  id: string;
  lender_invoice_number: string | null;
  serial_number: string | null;
  model: string | null;
  original_cents: number | null;
  current_cents: number | null;
  interest_cents: number | null;
  fees_cents: number | null;
  lender_code: string | null;
}

export interface NoteForMatch {
  id: string;
  lender_invoice_number: string;
  serial_number: string | null;
  model: string | null;
  original_principal_cents: number;
  principal_balance_cents: number;
  status: NoteStatus;
}

export interface Footer {
  principalCents: number | null;
  interestCents: number | null;
  feesCents: number | null;
  lineCount: number | null;
}

export interface FootingResult {
  ok: boolean;
  problems: string[];
  sums: { principalCents: number; interestCents: number; feesCents: number; lineCount: number };
}

export function footStatement(lines: Omit<StatementLineIn, 'id'>[], footer: Footer): FootingResult {
  const sums = {
    principalCents: lines.reduce((s, l) => s + (l.current_cents ?? 0), 0),
    interestCents: lines.reduce((s, l) => s + (l.interest_cents ?? 0), 0),
    feesCents: lines.reduce((s, l) => s + (l.fees_cents ?? 0), 0),
    lineCount: lines.length,
  };
  const problems: string[] = [];
  if (footer.principalCents == null) problems.push('The statement footer principal total is required.');
  else if (footer.principalCents !== sums.principalCents) {
    problems.push(`Lines total principal ${sums.principalCents} but the footer says ${footer.principalCents}.`);
  }
  if (footer.interestCents != null && footer.interestCents !== sums.interestCents) {
    problems.push(`Lines total interest ${sums.interestCents} but the footer says ${footer.interestCents}.`);
  }
  if (footer.feesCents != null && footer.feesCents !== sums.feesCents) {
    problems.push(`Lines total fees ${sums.feesCents} but the footer says ${footer.feesCents}.`);
  }
  if (footer.lineCount != null && footer.lineCount !== sums.lineCount) {
    problems.push(`The statement has ${sums.lineCount} lines but the footer says ${footer.lineCount}.`);
  }
  return { ok: problems.length === 0, problems, sums };
}

export function normalizeRef(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

export interface LineMatch {
  lineId: string;
  matchedNoteId: string | null;
  matchStatus: Extract<StatementMatchStatus, 'MATCHED' | 'VARIANCE' | 'LENDER_ONLY'>;
  method: StatementMatchMethod | null;
  varianceCents: number;
  overTolerance: boolean;
  sauFlag: boolean;
}

export interface RecordSaleTask {
  lineId: string;
  noteId: string;
}

export interface MatchResult {
  lines: LineMatch[];
  booksOnlyNoteIds: string[];
  recordSaleTasks: RecordSaleTask[];
  summary: { matched: number; variance: number; overTolerance: number; lenderOnly: number; booksOnly: number };
}

const LIVE: readonly NoteStatus[] = ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT'];

export function matchStatement(input: {
  kind: StatementKind;
  lines: StatementLineIn[];
  notes: NoteForMatch[];
  toleranceCents: number;
  sauCodes: string[];
}): MatchResult {
  const live = input.notes.filter((n) => LIVE.includes(n.status));
  const used = new Set<string>();
  const byInvoice = new Map<string, NoteForMatch[]>();
  const bySerial = new Map<string, NoteForMatch[]>();
  for (const n of live) {
    const k = normalizeRef(n.lender_invoice_number);
    byInvoice.set(k, [...(byInvoice.get(k) ?? []), n]);
    if (n.serial_number) {
      const s = normalizeRef(n.serial_number);
      bySerial.set(s, [...(bySerial.get(s) ?? []), n]);
    }
  }
  const sau = new Set(input.sauCodes.map(normalizeRef).filter(Boolean));
  const firstFree = (cands: NoteForMatch[] | undefined) => cands?.find((c) => !used.has(c.id)) ?? null;

  const lines: LineMatch[] = [];
  const tasks: RecordSaleTask[] = [];
  for (const l of input.lines) {
    let note: NoteForMatch | null = null;
    let method: StatementMatchMethod | null = null;
    if (l.lender_invoice_number) {
      note = firstFree(byInvoice.get(normalizeRef(l.lender_invoice_number)));
      if (note) method = 'INVOICE_NUMBER';
    }
    if (!note && l.serial_number) {
      note = firstFree(bySerial.get(normalizeRef(l.serial_number)));
      if (note) method = 'SERIAL';
    }
    if (!note && l.model && l.original_cents != null) {
      const m = normalizeRef(l.model);
      note = live.find((n) => !used.has(n.id) && normalizeRef(n.model) === m && n.original_principal_cents === l.original_cents) ?? null;
      if (note) method = 'MODEL_AMOUNT';
    }
    const sauFlag = l.lender_code != null && sau.has(normalizeRef(l.lender_code));
    if (!note) {
      lines.push({ lineId: l.id, matchedNoteId: null, matchStatus: 'LENDER_ONLY', method: null, varianceCents: 0, overTolerance: false, sauFlag });
      continue;
    }
    used.add(note.id);
    const variance = (l.current_cents ?? 0) - note.principal_balance_cents;
    const over = Math.abs(variance) > input.toleranceCents;
    lines.push({
      lineId: l.id,
      matchedNoteId: note.id,
      matchStatus: variance === 0 ? 'MATCHED' : 'VARIANCE',
      method,
      varianceCents: variance,
      overTolerance: over,
      sauFlag,
    });
    if (sauFlag && note.status === 'OPEN') tasks.push({ lineId: l.id, noteId: note.id });
  }

  const booksOnly = input.kind === 'PAYOFF_QUOTE' ? [] : live.filter((n) => !used.has(n.id)).map((n) => n.id);
  return {
    lines,
    booksOnlyNoteIds: booksOnly,
    recordSaleTasks: tasks,
    summary: {
      matched: lines.filter((x) => x.matchStatus === 'MATCHED').length,
      variance: lines.filter((x) => x.matchStatus === 'VARIANCE').length,
      overTolerance: lines.filter((x) => x.overTolerance).length,
      lenderOnly: lines.filter((x) => x.matchStatus === 'LENDER_ONLY').length,
      booksOnly: booksOnly.length,
    },
  };
}

export interface StoredLine {
  match_status: StatementMatchStatus;
  variance_cents: number;
}

/** Lines that block PREPARED: unresolved LENDER_ONLY / BOOKS_ONLY / UNMATCHED / over-tolerance VARIANCE. */
export function blockingLines<T extends StoredLine>(lines: T[], toleranceCents: number): T[] {
  return lines.filter(
    (l) =>
      l.match_status === 'UNMATCHED' ||
      l.match_status === 'LENDER_ONLY' ||
      l.match_status === 'BOOKS_ONLY' ||
      (l.match_status === 'VARIANCE' && Math.abs(l.variance_cents) > toleranceCents),
  );
}

export function assertApprover(preparedBy: string | null, approver: string): void {
  if (!preparedBy) throw new DealerEngineError('The reconciliation must be prepared before it is approved');
  if (preparedBy === approver) {
    throw new DealerEngineError('The preparer cannot approve their own reconciliation (separation of duties)');
  }
}
