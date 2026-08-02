export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * /api/debt/[id]
 *
 * GET    — one instrument with its full amortization schedule and, when linked, a
 *          thin read-only summary of its covenant. RLS scopes to the org.
 * DELETE — remove an instrument (schedule lines cascade). Posted GL entries are NOT
 *          reversed here — a posted accrual/payment is voided from the ledger.
 *
 * Dynamic-param routes can't use apiHandler (it only forwards the request).
 */

const INSTRUMENT_COLS =
  'id, location_id, loan_name, lender, facility, principal_cents, interest_rate, rate_type, ' +
  'amortization_method, payment_frequency, compounding, term_periods, payment_cents, ' +
  'origination_date, maturity_date, status, loan_covenant_id, liability_account_id, ' +
  'interest_expense_account_id, interest_payable_account_id, cash_account_id, notes, ' +
  'created_at, updated_at';

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
  const { data: entries } = await supabase
    .from('gl_entries')
    .select('source_ref, status')
    .eq('source_module', 'DEBT')
    .neq('status', 'VOIDED')
    .like('source_ref', `debt:%:${params.id}:%`);
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
  const linkId = (instrument as { loan_covenant_id: string | null }).loan_covenant_id;
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

  const { error } = await ctx.supabase.from('debt_instruments').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
