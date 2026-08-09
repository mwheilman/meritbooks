export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * GET /api/reconciliation/history — READ-ONLY reconciliation history.
 *
 * Two shapes, both RLS-scoped (writes nothing):
 *   • ?bank_account_id=…    → the prior FINALIZED reconciliations for one bank
 *                             account: statement date, statement + book (GL)
 *                             balances, the cleared total/count actually checked
 *                             off, and who locked it + when. Newest first.
 *   • ?reconciliation_id=…  → drill-in to ONE finalized reconciliation: its header
 *                             plus the cleared statement lines that were locked
 *                             into it (read-only).
 *
 * `bank_reconciliations` is org-isolated by RLS, so the list is already scoped to
 * the tenant. Finalizer display names live in `core.users`, which is self-read
 * only under RLS — so names are resolved with the admin client, restricted to the
 * exact `reconciled_by` ids drawn from the org's own (RLS-visible) reconciliations.
 */

interface RecRow {
  id: string;
  bank_account_id: string;
  fiscal_period_id: string;
  statement_ending_balance_cents: number | string;
  gl_balance_cents: number | string;
  is_reconciled: boolean;
  reconciled_at: string | null;
  reconciled_by: string | null;
  statement_date: string;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bank_account_id');
  const reconciliationId = searchParams.get('reconciliation_id');

  // ── Drill-in: one finalized reconciliation's cleared lines (read-only) ─────────
  if (reconciliationId) {
    const { data: recRaw, error: recErr } = await supabase
      .from('bank_reconciliations')
      .select(
        'id, bank_account_id, fiscal_period_id, statement_ending_balance_cents, gl_balance_cents, is_reconciled, reconciled_at, reconciled_by, statement_date',
      )
      .eq('id', reconciliationId)
      .maybeSingle();
    if (recErr) return NextResponse.json({ error: 'Failed to load reconciliation' }, { status: 500 });
    if (!recRaw) return NextResponse.json({ error: 'Reconciliation not found' }, { status: 404 });
    const rec = recRaw as RecRow;

    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_year, period_month')
      .eq('id', rec.fiscal_period_id)
      .maybeSingle();

    const { data: linesRaw, error: lineErr } = await supabase
      .from('bank_transactions')
      .select('id, description, amount_cents, transaction_date, status')
      .eq('reconciliation_id', rec.id)
      .order('transaction_date', { ascending: true });
    if (lineErr) return NextResponse.json({ error: 'Failed to load reconciled lines' }, { status: 500 });

    const lines = (linesRaw ?? []).map((r) => {
      const row = r as { id: string; description: string | null; amount_cents: number | string; transaction_date: string; status: string };
      const amountCents = num(row.amount_cents);
      return {
        id: row.id,
        description: row.description ?? 'Bank transaction',
        amountCents,
        isOutflow: amountCents < 0,
        transactionDate: row.transaction_date,
        status: row.status,
      };
    });
    let clearedDepositsCents = 0;
    let clearedPaymentsCents = 0;
    for (const l of lines) {
      if (l.amountCents >= 0) clearedDepositsCents += l.amountCents;
      else clearedPaymentsCents += -l.amountCents;
    }

    const finalizerName = await resolveFinalizerName(rec.reconciled_by);

    return NextResponse.json({
      reconciliation: {
        id: rec.id,
        periodYear: period?.period_year ?? null,
        periodMonth: period?.period_month ?? null,
        statementDate: rec.statement_date,
        statementEndingBalanceCents: num(rec.statement_ending_balance_cents),
        glBalanceCents: num(rec.gl_balance_cents),
        reconciledAt: rec.reconciled_at,
        reconciledByName: finalizerName,
        clearedCount: lines.length,
        clearedDepositsCents,
        clearedPaymentsCents,
        clearedNetCents: clearedDepositsCents - clearedPaymentsCents,
      },
      lines,
    });
  }

  // ── List: finalized reconciliations for one bank account ───────────────────────
  if (!bankAccountId) {
    return NextResponse.json(
      { error: 'bank_account_id or reconciliation_id is required' },
      { status: 400 },
    );
  }

  const { data: recsRaw, error: recsErr } = await supabase
    .from('bank_reconciliations')
    .select(
      'id, bank_account_id, fiscal_period_id, statement_ending_balance_cents, gl_balance_cents, is_reconciled, reconciled_at, reconciled_by, statement_date',
    )
    .eq('bank_account_id', bankAccountId)
    .eq('is_reconciled', true)
    .not('reconciled_at', 'is', null)
    .order('statement_date', { ascending: false })
    .limit(120);
  if (recsErr) return NextResponse.json({ error: 'Failed to load reconciliation history' }, { status: 500 });
  const recs = (recsRaw ?? []) as RecRow[];

  if (recs.length === 0) {
    return NextResponse.json({ reconciliations: [] });
  }

  // Cleared totals per reconciliation: sum the locked lines, grouped in JS.
  const { data: txnsRaw } = await supabase
    .from('bank_transactions')
    .select('reconciliation_id, amount_cents')
    .in('reconciliation_id', recs.map((r) => r.id));
  const clearedByRec = new Map<string, { count: number; netCents: number }>();
  for (const t of txnsRaw ?? []) {
    const row = t as { reconciliation_id: string | null; amount_cents: number | string };
    if (!row.reconciliation_id) continue;
    const agg = clearedByRec.get(row.reconciliation_id) ?? { count: 0, netCents: 0 };
    agg.count += 1;
    agg.netCents += num(row.amount_cents);
    clearedByRec.set(row.reconciliation_id, agg);
  }

  // Fiscal period labels.
  const { data: periodsRaw } = await supabase
    .from('fiscal_periods')
    .select('id, period_year, period_month')
    .in('id', recs.map((r) => r.fiscal_period_id));
  const periodMap = new Map<string, { year: number; month: number }>();
  for (const p of periodsRaw ?? []) {
    const row = p as { id: string; period_year: number; period_month: number };
    periodMap.set(row.id, { year: row.period_year, month: row.period_month });
  }

  // Finalizer names — admin client, restricted to the ids on these org-scoped recs.
  const finalizerNames = await resolveFinalizerNames(recs.map((r) => r.reconciled_by));

  return NextResponse.json({
    reconciliations: recs.map((r) => {
      const cleared = clearedByRec.get(r.id) ?? { count: 0, netCents: 0 };
      const period = periodMap.get(r.fiscal_period_id) ?? null;
      return {
        id: r.id,
        periodYear: period?.year ?? null,
        periodMonth: period?.month ?? null,
        statementDate: r.statement_date,
        statementEndingBalanceCents: num(r.statement_ending_balance_cents),
        glBalanceCents: num(r.gl_balance_cents),
        clearedCount: cleared.count,
        clearedNetCents: cleared.netCents,
        reconciledAt: r.reconciled_at,
        reconciledByName: r.reconciled_by ? finalizerNames.get(r.reconciled_by) ?? null : null,
      };
    }),
  });
}

/** Resolve a single core.users id to a display name (admin client). */
async function resolveFinalizerName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const map = await resolveFinalizerNames([userId]);
  return map.get(userId) ?? null;
}

/**
 * Resolve a set of core.users ids → display names via the admin client. core.users
 * is self-read only under RLS, so this is the sanctioned path; the ids come from
 * the caller's own org-scoped reconciliations, so no cross-tenant exposure.
 */
async function resolveFinalizerNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0)));
  if (unique.length === 0) return out;
  try {
    const admin = createAdminSupabase();
    const { data } = await admin
      .schema('core')
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', unique);
    for (const row of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>) {
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
      out.set(row.id, name || row.email || 'Unknown');
    }
  } catch (e) {
    console.error('[reconciliation/history] finalizer name lookup failed:', e instanceof Error ? e.message : e);
  }
  return out;
}
