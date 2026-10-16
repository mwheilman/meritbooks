export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { createDebtSchema, type CreateDebtInput } from '@/lib/debt/schema';
import { createDebtInstrument } from '@/lib/debt/create';
import { AmortizationError } from '@/lib/debt/amortization';
import { PostingError } from '@/lib/posting/account-roles';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listSessions } from '@/lib/onboarding/session';

/**
 * /api/debt
 *
 * GET  — list every debt instrument with a derived CURRENT balance and the NEXT
 *        scheduled payment (both computed from the stored amortization schedule).
 *        Read-only; RLS-scoped. Degrade-safe: no instruments → empty list.
 * POST — confirm/create an instrument. `apiHandler` enforces auth + Zod; the create
 *        service generates the amortization schedule deterministically and persists
 *        it. RLS enforces org isolation.
 *        - NEW loan: posts the origination JE → guarded by journal_entries:post.
 *        - EXISTING loan (B9, `existing_loan: true`): forward schedule from the current
 *          balance as of cutover, NO origination entry (the opening TB carries it) →
 *          an onboarding/setup action, guarded by settings_acct:edit.
 *
 * GET also returns `meta.onboarding` — whether this org is onboarding / has posted
 * opening balances and the cutover date — so the Add-loan form can default to
 * "This loan already exists" with the right as-of date.
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

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  // Company scope: when the header active company attaches `location_id`, narrow
  // to that entity's loans (consolidated when absent). RLS still isolates the org.
  const locationId = new URL(request.url).searchParams.get('location_id');

  let listQ = supabase
    .from('debt_instruments')
    .select(INSTRUMENT_COLS)
    .order('created_at', { ascending: false });
  if (locationId) listQ = listQ.eq('location_id', locationId);
  const { data: instruments, error } = await listQ;
  if (error) {
    console.error('[debt] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load debt instruments', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // The generated Database type omits debt_instruments, so `instruments` is typed
  // GenericStringError[]; restore type-safety against the local InstrumentRow.
  const rows = (instruments ?? []) as unknown as InstrumentRow[];
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
    // no period has elapsed yet, the schedule's OPENING balance is still outstanding
    // (balance after period 1 + period 1's principal — exact for new loans and for
    // existing loans brought over at their cutover balance).
    let currentBalanceCents = lines.length > 0
      ? lines[0].principal_balance_cents + lines[0].principal_cents
      : inst.principal_cents;
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

  return NextResponse.json({ data, meta: { onboarding: await onboardingHint(supabase, ctx.orgId) } });
}

/**
 * Whether new loans should default to EXISTING-loan mode (B9): true while the org is
 * onboarding (a conversion session exists) or once opening balances are posted. The
 * cutover date is the posted session's as-of date (else the newest session's).
 * Best-effort — any failure just means "default to a new loan".
 */
async function onboardingHint(
  supabase: ApiContext['supabase'],
  orgId: string | null,
): Promise<{ defaultExistingLoan: boolean; openingBalancesPosted: boolean; cutoverDate: string | null }> {
  if (!orgId) return { defaultExistingLoan: false, openingBalancesPosted: false, cutoverDate: null };
  try {
    const sessions = await listSessions(supabase, orgId);
    const posted = sessions.find((x) => x.posted) ?? null;
    const latest = sessions[0] ?? null;
    return {
      defaultExistingLoan: sessions.length > 0,
      openingBalancesPosted: !!posted,
      cutoverDate: posted?.asOfDate ?? latest?.asOfDate ?? null,
    };
  } catch {
    return { defaultExistingLoan: false, openingBalancesPosted: false, cutoverDate: null };
  }
}

export const POST = apiHandler(
  createDebtSchema,
  async (body: CreateDebtInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
    // A new loan posts an origination JE (money on the ledger); an existing loan brought
    // over at its balance posts nothing and is an onboarding/setup action.
    const guard = body.existing_loan
      ? await requirePermission(ctx.userId, 'settings_acct', 'edit')
      : await requirePermission(ctx.userId, 'journal_entries', 'post');
    if (!guard.ok) return guard.response;
    try {
      const result = await createDebtInstrument(ctx.supabase, ctx.orgId, ctx.userId, body);
      return NextResponse.json(
        {
          id: result.id,
          existing_loan: result.existingLoan,
          origination_posted: result.originationPosted,
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
      // Origination-posting failure (e.g. an unresolved role or no open fiscal period):
      // the create was rolled back, so surface a clear 422 rather than a 500.
      if (e instanceof PostingError) {
        return NextResponse.json({ error: e.message, code: 'ORIGINATION_POST_FAILED' }, { status: 422 });
      }
      console.error('[debt] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'Failed to create debt instrument', code: 'CREATE_FAILED' }, { status: 500 });
    }
  },
);
