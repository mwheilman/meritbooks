export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { createDebtSchema, type CreateDebtInput } from '@/lib/debt/schema';
import { createDebtInstrument } from '@/lib/debt/create';
import { AmortizationError } from '@/lib/debt/amortization';

/**
 * /api/debt
 *
 * GET  — list every debt instrument with a derived CURRENT balance and the NEXT
 *        scheduled payment (both computed from the stored amortization schedule).
 *        Read-only; RLS-scoped. Degrade-safe: no instruments → empty list.
 * POST — confirm/create an instrument. `apiHandler` enforces auth + Zod; the create
 *        service generates the amortization schedule deterministically and persists
 *        it. RLS enforces org isolation.
 */

const INSTRUMENT_COLS =
  'id, location_id, loan_name, lender, facility, principal_cents, interest_rate, rate_type, ' +
  'amortization_method, payment_frequency, compounding, term_periods, payment_cents, ' +
  'origination_date, maturity_date, status, loan_covenant_id, liability_account_id, ' +
  'interest_expense_account_id, interest_payable_account_id, cash_account_id, notes, ' +
  'created_at, updated_at';

interface ScheduleLine {
  period: number;
  period_date: string | null;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  principal_balance_cents: number;
}

interface InstrumentRow {
  id: string;
  principal_cents: number;
  [k: string]: unknown;
}

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { data: instruments, error } = await supabase
    .from('debt_instruments')
    .select(INSTRUMENT_COLS)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[debt] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load debt instruments', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const rows = (instruments ?? []) as InstrumentRow[];
  const ids = rows.map((r) => r.id);

  // Pull schedule lines for all instruments in one query, then derive per-instrument.
  const linesByInstrument = new Map<string, ScheduleLine[]>();
  if (ids.length > 0) {
    const { data: lines } = await supabase
      .from('debt_schedule_lines')
      .select('instrument_id, period, period_date, payment_cents, interest_cents, principal_cents, principal_balance_cents')
      .in('instrument_id', ids)
      .order('period', { ascending: true });
    for (const l of (lines ?? []) as (ScheduleLine & { instrument_id: string })[]) {
      const arr = linesByInstrument.get(l.instrument_id) ?? [];
      arr.push(l);
      linesByInstrument.set(l.instrument_id, arr);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const data = rows.map((inst) => {
    const lines = linesByInstrument.get(inst.id) ?? [];
    // Current balance = the balance after the most recent past-or-today period; if
    // no period has elapsed yet, the full original principal is still outstanding.
    let currentBalanceCents = inst.principal_cents;
    let nextPayment: ScheduleLine | null = null;
    for (const l of lines) {
      if (l.period_date && l.period_date <= today) {
        currentBalanceCents = l.principal_balance_cents;
      } else if (!nextPayment) {
        nextPayment = l;
      }
    }
    // If dates aren't set, fall back to the first unpaid line as "next".
    if (!nextPayment && lines.length > 0) nextPayment = lines[0];
    return {
      ...inst,
      periods: lines.length,
      current_balance_cents: currentBalanceCents,
      next_payment: nextPayment
        ? {
            period: nextPayment.period,
            period_date: nextPayment.period_date,
            payment_cents: nextPayment.payment_cents,
            interest_cents: nextPayment.interest_cents,
            principal_cents: nextPayment.principal_cents,
          }
        : null,
    };
  });

  return NextResponse.json({ data });
}

export const POST = apiHandler(
  createDebtSchema,
  async (body: CreateDebtInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
    try {
      const result = await createDebtInstrument(ctx.supabase, ctx.orgId, ctx.userId, body);
      return NextResponse.json(
        {
          id: result.id,
          schedule: {
            periods: result.schedule.periods,
            regular_payment_cents: result.schedule.regularPaymentCents,
            total_interest_cents: result.schedule.totalInterestCents,
            total_payment_cents: result.schedule.totalPaymentCents,
          },
        },
        { status: 201 },
      );
    } catch (e) {
      if (e instanceof AmortizationError) {
        return NextResponse.json({ error: e.message, code: 'SCHEDULE_ERROR' }, { status: 422 });
      }
      console.error('[debt] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'Failed to create debt instrument', code: 'CREATE_FAILED' }, { status: 500 });
    }
  },
);
