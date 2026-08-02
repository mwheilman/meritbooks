export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import {
  draftAdjustmentProposals,
  RECON_ADJUSTMENT_FEATURE,
  type ClassifiableBankLine,
} from '@/lib/services/reconciliation-adjustment-classify';
import {
  reconciliationDifferenceCents,
  type ClearedLine,
} from '@/lib/services/reconciliation-balance';

/**
 * GET /api/reconciliation/adjustment/suggest?reconciliation_id=...
 *
 * The AI-drafted adjusting-entry proposer (FPB Bank Reconciliation, Dimension 6;
 * feature `RECON_ADJUSTMENT`). It scans the reconciliation's unmatched, unposted
 * bank lines, classifies the well-known causes (bank fee, interest, NSF, sub-dollar
 * FX/rounding) into PROPOSED adjusting entries, and resolves each proposal's offset
 * account by role where it can. It is strictly READ-ONLY — it proposes, it never
 * posts. A human approves each one via POST /api/reconciliation/adjustment.
 *
 * The plug-vs-adjustment line (canon §3): lines with no explainable cause are
 * returned as UNEXPLAINED, and the current running variance is reported as-is — this
 * route never manufactures a plug to force the difference to zero.
 */

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

interface CandidateRow {
  id: string;
  description: string | null;
  amount_cents: number | string;
  gl_entry_id: string | null;
  reconciliation_id: string | null;
  reconciled_at: string | null;
}

/** Best-effort resolve an interest-income account for an `interest` proposal. */
async function findInterestIncomeAccountId(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('accounts')
    .select('id, account_type')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .in('account_type', ['REVENUE', 'OTHER'])
    .ilike('account_name', '%interest%')
    .limit(1)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const reconciliationId = searchParams.get('reconciliation_id');
  if (!reconciliationId) {
    return NextResponse.json({ error: 'reconciliation_id is required' }, { status: 400 });
  }

  // ── Load the reconciliation header (RLS-scoped) ────────────────────────────────
  const { data: recRaw, error: recErr } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, fiscal_period_id, statement_ending_balance_cents, is_reconciled, reconciled_at')
    .eq('id', reconciliationId)
    .maybeSingle();
  if (recErr) return NextResponse.json({ error: 'Failed to load reconciliation' }, { status: 500 });
  if (!recRaw) return NextResponse.json({ error: 'Reconciliation not found' }, { status: 404 });
  const rec = recRaw as {
    id: string;
    bank_account_id: string;
    fiscal_period_id: string;
    statement_ending_balance_cents: number | string;
    is_reconciled: boolean;
    reconciled_at: string | null;
  };
  const finalized = rec.reconciled_at != null || rec.is_reconciled;

  // ── Period window (candidate lines fall inside it) ─────────────────────────────
  const { data: period, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, start_date, end_date')
    .eq('id', rec.fiscal_period_id)
    .maybeSingle();
  if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });

  // ── All period lines for this account (drives the difference + the candidates) ─
  const { data: linesRaw, error: linesErr } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, gl_entry_id, reconciliation_id, reconciled_at')
    .eq('bank_account_id', rec.bank_account_id)
    .gte('transaction_date', period.start_date as string)
    .lte('transaction_date', period.end_date as string);
  if (linesErr) return NextResponse.json({ error: 'Failed to load transactions' }, { status: 500 });
  const lines = (linesRaw ?? []) as CandidateRow[];

  // Cleared lines → running difference to the statement (same math as the workspace).
  const clearedLines: ClearedLine[] = lines
    .filter((l) => l.reconciliation_id === rec.id)
    .map((l) => ({ amountCents: num(l.amount_cents) }));

  let beginningBalanceCents = 0;
  const { data: prior } = await supabase
    .from('bank_reconciliations')
    .select('statement_ending_balance_cents, statement_date')
    .eq('bank_account_id', rec.bank_account_id)
    .eq('is_reconciled', true)
    .lt('statement_date', period.end_date as string)
    .order('statement_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prior) beginningBalanceCents = num(prior.statement_ending_balance_cents);

  const differenceCents = reconciliationDifferenceCents({
    statementEndingBalanceCents: num(rec.statement_ending_balance_cents),
    beginningBalanceCents,
    clearedLines,
  });

  // Candidates: unmatched (not linked to any rec), unposted, unlocked feed lines —
  // exactly the lines an adjusting entry would book and clear.
  const candidates: ClassifiableBankLine[] = lines
    .filter((l) => l.reconciliation_id == null && l.reconciled_at == null && l.gl_entry_id == null)
    .map((l) => ({ id: l.id, description: l.description, amountCents: num(l.amount_cents) }));

  const { proposals, unexplainedLineIds } = draftAdjustmentProposals(candidates);

  // Resolve each proposal's offset account where a role is known (tolerate misses).
  const interestAccountId = proposals.some((p) => p.category === 'interest')
    ? await findInterestIncomeAccountId(supabase, orgId)
    : null;

  const resolved = await Promise.all(
    proposals.map(async (p) => {
      let offsetAccountId: string | null = null;
      if (p.offsetRole) {
        try {
          const ref = await resolveRole(supabase, orgId, p.offsetRole as AccountRoleKey);
          offsetAccountId = ref.id;
        } catch (e) {
          if (!(e instanceof PostingError)) throw e;
          offsetAccountId = null;
        }
      } else if (p.category === 'interest') {
        offsetAccountId = interestAccountId;
      }
      return {
        sourceTransactionId: p.sourceTransactionId,
        category: p.category,
        adjustmentType: p.adjustmentType,
        cashEffect: p.cashEffect,
        amountCents: p.amountCents,
        offsetAccountId,
        // The human must pick an account when we could not resolve one.
        needsOffsetAccount: p.adjustmentType !== 'bank_fee' && offsetAccountId == null,
        suggestedMemo: p.suggestedMemo,
        confidence: p.confidence,
        reasoning: p.reasoning,
      };
    }),
  );

  return NextResponse.json({
    feature: RECON_ADJUSTMENT_FEATURE,
    reconciliationId: rec.id,
    finalized,
    differenceCents,
    ties: differenceCents === 0,
    // Advisory: the residual that no proposal explains. NEVER auto-plugged.
    unexplainedVarianceCents: differenceCents,
    unexplainedLineCount: unexplainedLineIds.length,
    proposals: resolved,
  });
}
