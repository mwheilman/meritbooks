/**
 * Bank-reconciliation close gate (FPB Bank Reconciliation, Dimension 10 / D10.1,
 * AC10.1 — "reconciliation required to close period").
 *
 * A period must not HARD_CLOSE while a bank account is un-reconciled or a
 * reconciliation carries a non-zero, unexplained variance. This module is the
 * additive gate condition the period-close path consults. It has two parts:
 *
 *   • `evaluateReconciliationCloseGate` — PURE, exhaustively unit-tested: given the
 *     per-account reconciliation state for a period, decides pass / blocked and
 *     names every blocking account with a reason.
 *   • `gatherReconciliationCloseStatus` — the RLS-scoped read that assembles that
 *     state from `bank_accounts` + `bank_reconciliations` for one location + period.
 *
 * Canon: a reconciliation "ties" only when its difference is exactly $0 (the
 * finalize path enforces this). So the gate keys on the DELIBERATE finalize signal
 * (`reconciled_at`, or a legacy `is_reconciled` with a zero header difference) — a
 * draft that hasn't tied blocks the close, and a residual difference is reported as
 * an UNEXPLAINED variance, never assumed away.
 *
 * All amounts are bigint cents. The gatherer takes an RLS-scoped client, so tenant
 * isolation is enforced by the database.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One bank account's reconciliation state for the period being closed. */
export interface BankAccountRecStatus {
  bankAccountId: string;
  accountName: string;
  /** A reconciliation header exists for this account + period. */
  hasReconciliation: boolean;
  /** The reconciliation is finalized/locked AND tied (difference resolved to $0). */
  isReconciled: boolean;
  /** The header's residual difference in cents (0 = ties). Null when no header. */
  differenceCents: number | null;
}

export type RecCloseBlockerKind = 'unreconciled' | 'unexplained_variance';

export interface RecCloseBlocker {
  bankAccountId: string;
  accountName: string;
  kind: RecCloseBlockerKind;
  reason: string;
}

export interface RecCloseGateResult {
  pass: boolean;
  blockers: RecCloseBlocker[];
  /** Accounts considered (0 ⇒ no bank accounts for the entity ⇒ nothing to gate). */
  accountsConsidered: number;
  accountsReconciled: number;
}

function fmtCents(cents: number): string {
  const v = Math.abs(cents) / 100;
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
  return cents < 0 ? `(${s})` : s;
}

/**
 * Decide whether a period may HARD_CLOSE given every bank account's reconciliation
 * state. An account blocks when it has no reconciliation, has one that hasn't been
 * finalized, or carries a non-zero difference (an unexplained variance). With no
 * bank accounts there is nothing to reconcile → pass.
 */
export function evaluateReconciliationCloseGate(accounts: BankAccountRecStatus[]): RecCloseGateResult {
  const blockers: RecCloseBlocker[] = [];
  let accountsReconciled = 0;

  for (const a of accounts) {
    const diff = a.differenceCents ?? 0;

    if (!a.hasReconciliation) {
      blockers.push({
        bankAccountId: a.bankAccountId,
        accountName: a.accountName,
        kind: 'unreconciled',
        reason: `${a.accountName} is not reconciled for this period`,
      });
      continue;
    }

    if (!a.isReconciled) {
      if (diff !== 0) {
        blockers.push({
          bankAccountId: a.bankAccountId,
          accountName: a.accountName,
          kind: 'unexplained_variance',
          reason: `${a.accountName} has an unexplained variance of ${fmtCents(diff)} — resolve it (book the adjustment or investigate) before closing`,
        });
      } else {
        blockers.push({
          bankAccountId: a.bankAccountId,
          accountName: a.accountName,
          kind: 'unreconciled',
          reason: `${a.accountName} reconciliation is started but not finalized`,
        });
      }
      continue;
    }

    // Finalized but the header still shows a residual — defensive; never let a
    // non-zero difference pass as "tied".
    if (diff !== 0) {
      blockers.push({
        bankAccountId: a.bankAccountId,
        accountName: a.accountName,
        kind: 'unexplained_variance',
        reason: `${a.accountName} is marked reconciled but carries a ${fmtCents(diff)} variance`,
      });
      continue;
    }

    accountsReconciled += 1;
  }

  return {
    pass: blockers.length === 0,
    blockers,
    accountsConsidered: accounts.length,
    accountsReconciled,
  };
}

interface BankAccountRow {
  id: string;
  account_name: string | null;
}
interface ReconRow {
  bank_account_id: string;
  is_reconciled: boolean | null;
  reconciled_at: string | null;
  difference_cents: number | string | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read the per-account reconciliation state for one entity + fiscal period, then
 * evaluate the gate. RLS-scoped client ⇒ tenant isolation enforced by the DB.
 * Returns `pass: true` with zero accounts when the entity has no active bank
 * accounts (nothing to reconcile).
 */
export async function gatherReconciliationCloseStatus(
  supabase: SupabaseClient,
  args: { locationId: string; fiscalPeriodId: string },
): Promise<RecCloseGateResult> {
  const { data: acctData } = await supabase
    .from('bank_accounts')
    .select('id, account_name')
    .eq('location_id', args.locationId)
    .eq('is_active', true);
  const accounts = (acctData ?? []) as BankAccountRow[];
  if (accounts.length === 0) {
    return { pass: true, blockers: [], accountsConsidered: 0, accountsReconciled: 0 };
  }

  const accountIds = accounts.map((a) => a.id);
  const { data: recData } = await supabase
    .from('bank_reconciliations')
    .select('bank_account_id, is_reconciled, reconciled_at, difference_cents, created_at')
    .eq('fiscal_period_id', args.fiscalPeriodId)
    .in('bank_account_id', accountIds)
    .order('created_at', { ascending: false });
  const recs = (recData ?? []) as (ReconRow & { created_at?: string })[];

  // Keep the most recent reconciliation per account (ordered desc above).
  const latestByAccount = new Map<string, ReconRow>();
  for (const r of recs) {
    if (!latestByAccount.has(r.bank_account_id)) latestByAccount.set(r.bank_account_id, r);
  }

  const statuses: BankAccountRecStatus[] = accounts.map((a) => {
    const rec = latestByAccount.get(a.id);
    const accountName = a.account_name ?? 'Bank account';
    if (!rec) {
      return { bankAccountId: a.id, accountName, hasReconciliation: false, isReconciled: false, differenceCents: null };
    }
    const differenceCents = num(rec.difference_cents);
    // "Reconciled" = the deliberate finalize (reconciled_at) OR a legacy is_reconciled
    // header that ties to $0. A non-zero difference is never treated as reconciled.
    const isReconciled = (rec.reconciled_at != null || rec.is_reconciled === true) && differenceCents === 0;
    return { bankAccountId: a.id, accountName, hasReconciliation: true, isReconciled, differenceCents };
  });

  return evaluateReconciliationCloseGate(statuses);
}
