/**
 * Split → journal entries (FPB-bank-feed-splits §5, AC-2/3/4) — pure, deterministic.
 *
 * The bank (or card) account belongs to company A. Lines that book to A land in A's
 * JE; lines that book to another company B land in B's own JE, and the money crossing
 * between the two books rides the intercompany pair (same shape as EXPENSE_ON_BEHALF in
 * lib/services/intercompany.ts):
 *
 *   outflow   A: DR A-lines · DR IC Receivable Σ(B) [cp B] / CR cash-or-card T
 *             B: DR B-lines / CR IC Payable Σ(B) [cp A]
 *   inflow    A: DR cash T / CR A-lines · CR IC Payable Σ(B) [cp B]
 *             B: DR IC Receivable Σ(B) [cp A] / CR B-lines
 *
 * Every JE balances on its own; A's IC Receivable equals B's IC Payable, so the pair
 * eliminates on consolidation. Debit/credit direction comes from the transaction's
 * direction (money out vs in), never from a hard-coded account number.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import { checkSplitAmounts } from './allocate';

export interface SplitLineForPosting {
  lineNo: number;
  amountCents: number;
  accountId: string;
  /** The company this line books to. */
  locationId: string;
  departmentId?: string | null;
  classId?: string | null;
  jobId?: string | null;
  memo?: string | null;
}

export interface SplitPostingInput {
  /** Company that owns the bank / card account. */
  bankLocationId: string;
  /** The bank's GL account (cash) or the card's liability account. */
  cashAccountId: string;
  /** Signed: negative = money out, positive = money in (bank_transactions.amount_cents). */
  signedAmountCents: number;
  lines: ReadonlyArray<SplitLineForPosting>;
  /** Required only when a line books to another company. */
  icReceivableAccountId?: string | null;
  icPayableAccountId?: string | null;
  /** Default memo for lines without their own. */
  memo?: string;
}

export interface PlannedEntry {
  locationId: string;
  lines: JournalEntryLineInput[];
  /** For each split line in this entry: its index in `lines` (→ gl line_number - 1). */
  splitLineIndex: Array<{ lineNo: number; index: number }>;
}

export class SplitPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitPlanError';
  }
}

function dims(l: SplitLineForPosting): Pick<JournalEntryLineInput, 'department_id' | 'class_id' | 'job_id'> {
  return {
    department_id: l.departmentId ?? undefined,
    class_id: l.classId ?? undefined,
    job_id: l.jobId ?? undefined,
  };
}

/** Plan the balanced entries for a split. The bank company's entry is always first. */
export function planSplitEntries(input: SplitPostingInput): PlannedEntry[] {
  const total = Math.abs(input.signedAmountCents);
  if (!Number.isInteger(input.signedAmountCents) || total === 0) throw new SplitPlanError('The transaction has no amount to split.');
  const check = checkSplitAmounts(total, input.lines.map((l) => l.amountCents));
  if (!check.ok) throw new SplitPlanError(check.error ?? 'Invalid split.');
  const seen = new Set<number>();
  for (const l of input.lines) {
    if (seen.has(l.lineNo)) throw new SplitPlanError(`Duplicate split line number ${l.lineNo}.`);
    seen.add(l.lineNo);
  }

  const outflow = input.signedAmountCents < 0;
  const A = input.bankLocationId;
  const ordered = [...input.lines].sort((a, b) => a.lineNo - b.lineNo);
  const own = ordered.filter((l) => l.locationId === A);
  const others = new Map<string, SplitLineForPosting[]>();
  for (const l of ordered) {
    if (l.locationId === A) continue;
    const arr = others.get(l.locationId) ?? [];
    arr.push(l);
    others.set(l.locationId, arr);
  }
  if (others.size > 0 && (!input.icReceivableAccountId || !input.icPayableAccountId)) {
    throw new SplitPlanError('Intercompany Receivable / Payable accounts are required for a cross-company split.');
  }
  const icAr = input.icReceivableAccountId as string;
  const icAp = input.icPayableAccountId as string;
  const memoOf = (l: SplitLineForPosting) => l.memo?.trim() || input.memo || undefined;

  // ── the bank company's entry ──
  const aLines: JournalEntryLineInput[] = [];
  const aIndex: PlannedEntry['splitLineIndex'] = [];
  if (!outflow) aLines.push({ account_id: input.cashAccountId, debit_cents: total, credit_cents: 0, location_id: A, memo: 'Bank deposit' });
  for (const l of own) {
    aIndex.push({ lineNo: l.lineNo, index: aLines.length });
    aLines.push({
      account_id: l.accountId,
      debit_cents: outflow ? l.amountCents : 0,
      credit_cents: outflow ? 0 : l.amountCents,
      location_id: A,
      ...dims(l),
      memo: memoOf(l),
    });
  }
  for (const [loc, ls] of others) {
    const sum = ls.reduce((s, l) => s + l.amountCents, 0);
    aLines.push({
      account_id: outflow ? icAr : icAp,
      debit_cents: outflow ? sum : 0,
      credit_cents: outflow ? 0 : sum,
      location_id: A,
      counterparty_location_id: loc,
      memo: outflow ? 'Due from affiliate (split)' : 'Due to affiliate (split)',
    });
  }
  if (outflow) aLines.push({ account_id: input.cashAccountId, debit_cents: 0, credit_cents: total, location_id: A, memo: 'Bank / card payment' });

  const plan: PlannedEntry[] = [{ locationId: A, lines: aLines, splitLineIndex: aIndex }];

  // ── each other company's entry ──
  for (const [loc, ls] of others) {
    const sum = ls.reduce((s, l) => s + l.amountCents, 0);
    const lines: JournalEntryLineInput[] = [];
    const idx: PlannedEntry['splitLineIndex'] = [];
    if (!outflow) {
      lines.push({ account_id: icAr, debit_cents: sum, credit_cents: 0, location_id: loc, counterparty_location_id: A, memo: 'Due from affiliate (split)' });
    }
    for (const l of ls) {
      idx.push({ lineNo: l.lineNo, index: lines.length });
      lines.push({
        account_id: l.accountId,
        debit_cents: outflow ? l.amountCents : 0,
        credit_cents: outflow ? 0 : l.amountCents,
        location_id: loc,
        ...dims(l),
        memo: memoOf(l),
      });
    }
    if (outflow) {
      lines.push({ account_id: icAp, debit_cents: 0, credit_cents: sum, location_id: loc, counterparty_location_id: A, memo: 'Due to affiliate (split)' });
    }
    plan.push({ locationId: loc, lines, splitLineIndex: idx });
  }

  for (const e of plan) {
    const dr = e.lines.reduce((s, l) => s + l.debit_cents, 0);
    const cr = e.lines.reduce((s, l) => s + l.credit_cents, 0);
    if (dr !== cr || dr === 0 || e.lines.length < 2) {
      throw new SplitPlanError(`Internal: planned entry for company ${e.locationId} does not balance.`);
    }
  }
  return plan;
}

/** The idempotency key stamped on each posted JE (unique with entry_type, migration 064). */
export function splitSourceRef(txnId: string, version: number, locationId: string, bankLocationId: string): string {
  return locationId === bankLocationId ? `bankfeed:${txnId}:v${version}` : `bankfeed:${txnId}:v${version}:${locationId}`;
}
