export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * /api/debt/[id]
 *
 * GET    — one instrument with its full amortization schedule and, when linked, a
 *          thin read-only summary of its covenant. RLS scopes to the org.
 * DELETE — remove an instrument (schedule lines cascade). Gated on
 *          journal_entries:post and REFUSED (409) once any non-voided GL entry
 *          references it — void those entries first (mirrors leases).
 *
 * Dynamic-param routes can't use apiHandler (it only forwards the request).
 */

// PostgREST aliases map the EXISTING migration-008 columns to the feature field
// names the API + UI expect (name -> loan_name, original_amount_cents ->
// principal_cents, monthly_payment_cents -> payment_cents, gl_liability_account_id ->
// liability_account_id, gl_interest_account_id -> interest_expense_account_id).
const INSTRUMENT_COLS =
  'id, location_id, loan_name:name, lender, facility, principal_cents:original_amount_cents, ' +
  'interest_rate, rate_type, amortization_method, payment_frequency, compounding, term_periods, ' +
  'payment_cents:monthly_payment_cents, origination_date, maturity_date, status, loan_covenant_id, ' +
  'liability_account_id:gl_liability_account_id, interest_expense_account_id:gl_interest_account_id, ' +
  'interest_payable_account_id, cash_account_id, notes, created_at, updated_at';

interface Params {
  params: { id: string };
}

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { data: instrument, error } = await supabase
    .from('debt_instruments')
    .select(INSTRUMENT_COLS)
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  if (!instrument) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data: lines } = await supabase
    .from('debt_schedule_lines')
    .select('period, period_date, payment_cents, interest_cents, principal_cents, principal_balance_cents')
    .eq('instrument_id', params.id)
    .order('period', { ascending: true });

  // Which periods already posted an accrual / payment? Read the source_ref guards.
  const refs = new Set<string>();
  // Paged: a long-dated loan's accrual + payment entries can pass PostgREST's 1,000-row cap.
  const { data: entries } = await fetchAll(
    () =>
      supabase
        .from('gl_entries')
        .select('source_ref, status')
        .eq('source_module', 'DEBT')
        .neq('status', 'VOIDED')
        .like('source_ref', `debt:%:${params.id}:%`),
    { label: 'debt-detail gl_entries' },
  );
  for (const e of (entries ?? []) as { source_ref: string | null }[]) {
    if (e.source_ref) refs.add(e.source_ref);
  }

  const scheduleLines = ((lines ?? []) as {
    period: number;
    period_date: string | null;
    payment_cents: number;
    interest_cents: number;
    principal_cents: number;
    principal_balance_cents: number;
  }[]).map((l) => ({
    ...l,
    accrued: refs.has(`debt:accrual:${params.id}:${l.period}`),
    paid: refs.has(`debt:payment:${params.id}:${l.period}`),
  }));

  // Optional covenant summary (read-only link).
  let covenant: { id: string; loan_name: string; covenant_type: string } | null = null;
  const linkId = (instrument as unknown as { loan_covenant_id: string | null }).loan_covenant_id;
  if (linkId) {
    const { data: cov } = await supabase
      .from('loan_covenants')
      .select('id, loan_name, covenant_type')
      .eq('id', linkId)
      .maybeSingle();
    covenant = (cov as typeof covenant) ?? null;
  }

  return NextResponse.json({ data: { instrument, schedule: scheduleLines, covenant } });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Authorize (security MEDIUM) — an instrument drives GL postings (origination,
  // accruals, payments, payoff); removing it is gated like creating a new loan
  // (journal_entries:post). Fails closed.
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  const { data: inst } = await supabase
    .from('debt_instruments')
    .select('id')
    .eq('id', params.id)
    .eq('org_id', orgId)
    .maybeSingle<{ id: string }>();
  if (!inst) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  // Mirror leases: refuse once ANY non-voided GL entry references this instrument
  // (origination / accrual / payment / payoff / refinance refs all embed its id),
  // so posted entries are never orphaned from their source.
  const { count: postedCount, error: postedErr } = await supabase
    .from('gl_entries')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('source_module', 'DEBT')
    .neq('status', 'VOIDED')
    .like('source_ref', `debt:%${params.id}%`);
  if (postedErr) return NextResponse.json({ error: postedErr.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  if ((postedCount ?? 0) > 0) {
    return NextResponse.json(
      { error: 'This loan has posted GL entries and cannot be deleted. Void the entries first.', code: 'HAS_POSTINGS' },
      { status: 409 },
    );
  }

  const { error } = await supabase.from('debt_instruments').delete().eq('id', params.id).eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
