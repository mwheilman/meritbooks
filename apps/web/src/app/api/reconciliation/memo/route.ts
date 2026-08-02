export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { runAiGateway } from '@meritbooks/core-ai';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { fetchCoreMap } from '@/lib/stitch-core';
import { computeGlCashBalanceCents } from '@/lib/services/reconciliation-gl';
import {
  reconciliationDifferenceCents,
  splitClearedTotals,
} from '@/lib/services/reconciliation-balance';
import {
  detectStaleItems,
  summarizeStaleItems,
  assessPlug,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type OutstandingItem,
} from '@/lib/services/reconciliation-plug';
import {
  buildMemoFacts,
  deterministicMemo,
  memoUserPrompt,
  RECON_MEMO_FEATURE,
  RECON_MEMO_MODEL,
  RECON_MEMO_SYSTEM,
  type ReconMemoFacts,
} from '@/lib/services/reconciliation-memo';

/**
 * GET /api/reconciliation/memo?reconciliation_id=...&stale_days=30
 *
 * The AI-drafted reconciliation memo (FPB Bank Reconciliation, Wave B). Canon §3:
 * EVERY figure is computed here in code from the RLS-scoped ledger + statement; the
 * model only PHRASES the supplied numbers. Read-only — it drafts, it never writes
 * the ledger. Degrade-safe: with no key / a blocked budget / a gateway error, the
 * deterministic memo is returned so a draft always exists. The override columns are
 * OPTIONAL (reserved migration) — the memo tolerates their absence.
 */

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

interface HeaderRow {
  id: string;
  bank_account_id: string;
  fiscal_period_id: string;
  statement_ending_balance_cents: number | string;
  is_reconciled: boolean;
  reconciled_at: string | null;
  statement_date: string;
}

/** Beginning balance = prior finalized statement ending balance for this account. */
async function priorEndingBalanceCents(
  supabase: SupabaseClient,
  bankAccountId: string,
  endDate: string,
): Promise<number> {
  const { data } = await supabase
    .from('bank_reconciliations')
    .select('statement_ending_balance_cents, statement_date')
    .eq('bank_account_id', bankAccountId)
    .eq('is_reconciled', true)
    .lt('statement_date', endDate)
    .order('statement_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? num(data.statement_ending_balance_cents) : 0;
}

/** Read the optional override columns; tolerate their absence (reserved migration). */
async function readOverride(
  supabase: SupabaseClient,
  reconciliationId: string,
): Promise<{ overridden: boolean; reason: string | null }> {
  const { data, error } = await supabase
    .from('bank_reconciliations')
    .select('finalized_via_override, finalize_override_reason')
    .eq('id', reconciliationId)
    .maybeSingle();
  if (error || !data) return { overridden: false, reason: null };
  const row = data as { finalized_via_override?: boolean | null; finalize_override_reason?: string | null };
  return { overridden: row.finalized_via_override === true, reason: row.finalize_override_reason ?? null };
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const reconciliationId = searchParams.get('reconciliation_id');
  if (!reconciliationId) {
    return NextResponse.json({ error: 'reconciliation_id is required' }, { status: 400 });
  }
  const staleThresholdDays = Math.max(
    1,
    Math.min(365, Number(searchParams.get('stale_days')) || DEFAULT_STALE_THRESHOLD_DAYS),
  );

  // ── Header (RLS-scoped) ────────────────────────────────────────────────────────
  const { data: recRaw, error: recErr } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, fiscal_period_id, statement_ending_balance_cents, is_reconciled, reconciled_at, statement_date')
    .eq('id', reconciliationId)
    .maybeSingle();
  if (recErr) return NextResponse.json({ error: 'Failed to load reconciliation' }, { status: 500 });
  if (!recRaw) return NextResponse.json({ error: 'Reconciliation not found' }, { status: 404 });
  const header = recRaw as HeaderRow;
  const finalized = header.reconciled_at != null || header.is_reconciled;

  // ── Bank account + period ──────────────────────────────────────────────────────
  const { data: acctRaw, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_id, location_id')
    .eq('id', header.bank_account_id)
    .maybeSingle();
  if (acctErr || !acctRaw) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  const account = acctRaw as {
    id: string;
    account_name: string;
    account_mask: string | null;
    account_id: string;
    location_id: string;
  };

  const { data: period, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, period_year, period_month, start_date, end_date')
    .eq('org_id', orgId)
    .eq('id', header.fiscal_period_id)
    .maybeSingle();
  if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });

  // ── Cleared totals for the difference (same math as the workspace) ──────────────
  const { data: clearedRaw } = await supabase
    .from('bank_transactions')
    .select('amount_cents')
    .eq('reconciliation_id', header.id);
  const clearedLines = (clearedRaw ?? []).map((r) => ({ amountCents: num((r as { amount_cents: number }).amount_cents) }));
  const totals = splitClearedTotals(clearedLines);

  const beginningBalanceCents = await priorEndingBalanceCents(supabase, header.bank_account_id, period.end_date as string);
  const statementEndingBalanceCents = num(header.statement_ending_balance_cents);
  const differenceCents = reconciliationDifferenceCents({
    statementEndingBalanceCents,
    beginningBalanceCents,
    clearedLines,
  });
  const plug = assessPlug(differenceCents);

  const glCashBalanceCents = await computeGlCashBalanceCents(supabase, {
    orgId,
    locationId: account.location_id,
    accountId: account.account_id,
    endDate: period.end_date as string,
  });

  // ── Outstanding (never-cleared) items for staleness detection ──────────────────
  // Aged reconciling items can predate the period window, so scan the account's
  // feed for lines never linked to any reconciliation as of the statement date.
  const { data: outRaw } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date')
    .eq('bank_account_id', header.bank_account_id)
    .is('reconciliation_id', null)
    .is('reconciled_at', null)
    .lte('transaction_date', period.end_date as string)
    .order('transaction_date', { ascending: true })
    .limit(500);
  const outstanding: OutstandingItem[] = (outRaw ?? []).map((r) => {
    const row = r as { id: string; description: string | null; amount_cents: number | string; transaction_date: string };
    return {
      id: row.id,
      description: row.description ?? 'Bank transaction',
      amountCents: num(row.amount_cents),
      transactionDate: row.transaction_date,
    };
  });
  const staleItems = detectStaleItems(outstanding, {
    asOfDate: period.end_date as string,
    thresholdDays: staleThresholdDays,
  });
  const staleTotals = summarizeStaleItems(staleItems);

  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase,
    'locations',
    'id, name, short_code',
    [account.location_id],
  );
  const locationName = locMap.get(account.location_id)?.name ?? '';

  const override = finalized ? await readOverride(supabase, header.id) : { overridden: false, reason: null };

  const facts: ReconMemoFacts = {
    accountName: account.account_name,
    accountMask: account.account_mask ?? '',
    locationName,
    periodLabel: `${MONTHS[(period.period_month as number) - 1] ?? ''} ${period.period_year}`.trim(),
    statementDate: header.statement_date,
    beginningBalanceCents,
    statementEndingBalanceCents,
    glCashBalanceCents,
    clearedDepositsCents: totals.depositsCents,
    clearedPaymentsCents: totals.paymentsCents,
    clearedNetCents: totals.netCents,
    clearedBalanceCents: beginningBalanceCents + totals.netCents,
    clearedCount: clearedLines.length,
    outstandingCount: outstanding.length,
    differenceCents,
    ties: plug.ties,
    plugCents: plug.plugCents,
    staleCount: staleTotals.count,
    staleOutstandingChecksCents: staleTotals.outstandingChecksCents,
    staleDepositsInTransitCents: staleTotals.depositsInTransitCents,
    staleThresholdDays,
    finalized,
    overridden: override.overridden,
    overrideReason: override.reason,
  };

  const factSheet = buildMemoFacts(facts);
  const fallback = deterministicMemo(facts);

  // Structured figures always come from OUR computation (the model only phrases).
  const responseSummary = {
    beginningBalanceCents: facts.beginningBalanceCents,
    statementEndingBalanceCents: facts.statementEndingBalanceCents,
    glCashBalanceCents: facts.glCashBalanceCents,
    clearedNetCents: facts.clearedNetCents,
    clearedBalanceCents: facts.clearedBalanceCents,
    clearedCount: facts.clearedCount,
    outstandingCount: facts.outstandingCount,
    differenceCents: facts.differenceCents,
    ties: facts.ties,
    plugCents: facts.plugCents,
    staleCount: facts.staleCount,
    staleThresholdDays: facts.staleThresholdDays,
    finalized: facts.finalized,
    overridden: facts.overridden,
  };
  const responseStale = staleItems.slice(0, 25).map((s) => ({
    id: s.id,
    description: s.description,
    amountCents: s.amountCents,
    transactionDate: s.transactionDate,
    ageDays: s.ageDays,
    isOutflow: s.isOutflow,
  }));

  // ── Phrase the facts via the gateway; degrade to deterministic ─────────────────
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json({
      memo: fallback,
      summary: responseSummary,
      staleItems: responseStale,
      meta: { source: 'deterministic', model: null, decisionId: null, message: 'AI provider key not configured' },
    });
  }

  const admin = createAdminSupabase();
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: orgId,
        user_id: userId,
        module: 'BOOKS',
        feature: RECON_MEMO_FEATURE,
        model: RECON_MEMO_MODEL,
        system: RECON_MEMO_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: memoUserPrompt(factSheet) }] }],
        max_tokens: 500,
      },
    );
  } catch (e) {
    return NextResponse.json({
      memo: fallback,
      summary: responseSummary,
      staleItems: responseStale,
      meta: { source: 'deterministic', model: null, decisionId: null, message: e instanceof Error ? e.message : 'Gateway error' },
    });
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return NextResponse.json({
      memo: fallback,
      summary: responseSummary,
      staleItems: responseStale,
      meta: { source: 'deterministic', model: gw.model_used, decisionId: null, budgetState: gw.budget.state, message: gw.message ?? 'AI request blocked' },
    });
  }

  const text = extractText(gw.result);
  const memo = (text ?? '').trim() || fallback;

  // Audit the AI proposal to the decision-log rail (org-scoped, RLS).
  let decisionId: string | null = null;
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: RECON_MEMO_FEATURE,
        model_requested: RECON_MEMO_MODEL,
        model_used: gw.model_used,
        correlation_id: gw.correlation_id,
        input_summary: `Reconciliation memo — ${facts.accountName} ${facts.periodLabel}`.slice(0, 2000),
        proposed_output: { memo, summary: responseSummary },
        reasoning: 'AI phrasing of deterministically-computed reconciliation figures; figures authored in code, not by the model.',
        status: 'PROPOSED',
        tokens_input: gw.tokens.input,
        tokens_output: gw.tokens.output,
        cost_cents: gw.cost_cents,
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[reconciliation-memo] decision log failed (non-fatal):', e);
  }

  return NextResponse.json({
    memo,
    summary: responseSummary,
    staleItems: responseStale,
    meta: { source: 'ai', model: gw.model_used, decisionId, budgetState: gw.budget.state, costCents: gw.cost_cents, message: gw.message },
  });
}
