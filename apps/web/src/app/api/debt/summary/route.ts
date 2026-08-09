export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { buildCovenantStatus, type CovenantRow } from '@/lib/covenants/status';

/**
 * GET /api/debt/summary?location_id=<uuid>
 *
 * At-a-glance debt posture for the Debt & Loans screen:
 *   • total outstanding, split current (principal due ≤ 12 months) vs non-current
 *   • the next scheduled payment across all active loans
 *   • total debt service coming due in the next 12 months (interest vs principal)
 *   • a thin covenant-headroom roll-up (counts by band + worst headroom) — the
 *     full Covenant Monitor lives on its own tab; this only links to it.
 *
 * Everything derives deterministically from the stored amortization schedules and
 * the live ledger. Read-only, RLS-scoped, degrade-safe.
 */

interface InstrumentRow {
  id: string; name: string; lender: string | null; status: string;
  original_amount_cents: number | string | null; location_id: string | null;
}
interface ScheduleRow {
  instrument_id: string; period: number; period_date: string | null;
  payment_cents: number | string | null; interest_cents: number | string | null;
  principal_cents: number | string | null; principal_balance_cents: number | string | null;
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const locationId = new URL(request.url).searchParams.get('location_id');
  const today = new Date();
  const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayIso = isoDate(anchor);
  const in12mo = new Date(anchor);
  in12mo.setUTCFullYear(in12mo.getUTCFullYear() + 1);
  const in12moIso = isoDate(in12mo);

  // 1. Active instruments in scope.
  let instQ = supabase
    .from('debt_instruments')
    .select('id, name, lender, status, original_amount_cents, location_id')
    .eq('status', 'ACTIVE');
  if (locationId) instQ = instQ.eq('location_id', locationId);
  const { data: instData, error: instErr } = await instQ;
  if (instErr) {
    console.error('[debt/summary] instruments failed:', instErr.message);
    return NextResponse.json({ error: 'Failed to load debt summary', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  const instruments = (instData ?? []) as InstrumentRow[];
  const instById = new Map(instruments.map((i) => [i.id, i]));

  let totalOutstandingCents = 0;
  let currentPortionCents = 0;      // principal due within 12 months
  let serviceNext12MoCents = 0;     // total payments due within 12 months
  let interestNext12MoCents = 0;
  let principalNext12MoCents = 0;
  let loansWithSchedule = 0;
  let nextPayment: { instrumentId: string; loanName: string; lender: string | null; period: number; dueDate: string | null; paymentCents: number } | null = null;

  if (instruments.length > 0) {
    const { data: lineData } = await supabase
      .from('debt_schedule_lines')
      .select('instrument_id, period, period_date, payment_cents, interest_cents, principal_cents, principal_balance_cents')
      .in('instrument_id', instruments.map((i) => i.id))
      .order('period', { ascending: true });
    const lines = (lineData ?? []) as ScheduleRow[];

    const byInstrument = new Map<string, ScheduleRow[]>();
    for (const l of lines) {
      const arr = byInstrument.get(l.instrument_id) ?? [];
      arr.push(l);
      byInstrument.set(l.instrument_id, arr);
    }

    for (const inst of instruments) {
      const sched = byInstrument.get(inst.id) ?? [];
      // Current balance = balance after the most recent past-or-today line, else
      // the full original principal (mirrors /api/debt list derivation).
      let currentBalance = Number(inst.original_amount_cents ?? 0);
      if (sched.length > 0) {
        loansWithSchedule += 1;
        for (const l of sched) {
          if (l.period_date && l.period_date <= todayIso) {
            currentBalance = Number(l.principal_balance_cents ?? currentBalance);
          }
        }
      }
      totalOutstandingCents += currentBalance;

      // Upcoming lines (due after today) drive current portion + 12-mo service.
      for (const l of sched) {
        if (!l.period_date || l.period_date <= todayIso) continue;
        const within12 = l.period_date <= in12moIso;
        if (within12) {
          currentPortionCents += Number(l.principal_cents ?? 0);
          serviceNext12MoCents += Number(l.payment_cents ?? 0);
          interestNext12MoCents += Number(l.interest_cents ?? 0);
          principalNext12MoCents += Number(l.principal_cents ?? 0);
        }
        // Earliest upcoming line across all loans = the next payment.
        if (Number(l.payment_cents ?? 0) > 0) {
          if (!nextPayment || (l.period_date < (nextPayment.dueDate ?? '9999-99-99'))) {
            nextPayment = {
              instrumentId: inst.id,
              loanName: inst.name,
              lender: inst.lender,
              period: l.period,
              dueDate: l.period_date,
              paymentCents: Number(l.payment_cents ?? 0),
            };
          }
        }
      }
    }
  }

  // Current portion can't exceed the outstanding balance (interest-only balloons
  // etc.); clamp so the non-current split never goes negative.
  currentPortionCents = Math.min(currentPortionCents, totalOutstandingCents);
  const nonCurrentPortionCents = Math.max(0, totalOutstandingCents - currentPortionCents);

  // 2. Covenant headroom roll-up (thin — the Monitor tab owns the detail).
  const covenantSummary = { total: 0, breach: 0, warn: 0, pass: 0, unknown: 0 };
  let worstHeadroom: { loanName: string; covenantType: string; headroomPct: number | null; band: string } | null = null;
  {
    let covQ = supabase
      .from('loan_covenants')
      .select(
        'id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, ' +
          'test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, created_at, updated_at',
      );
    if (locationId) covQ = covQ.eq('location_id', locationId);
    const { data: covData } = await covQ;
    const rows = (covData ?? []) as unknown as CovenantRow[];
    covenantSummary.total = rows.length;
    for (const row of rows) {
      try {
        const status = await buildCovenantStatus(supabase, row);
        const band = status.evaluation.band;
        if (band === 'BREACH') covenantSummary.breach += 1;
        else if (band === 'WARN') covenantSummary.warn += 1;
        else if (band === 'PASS') covenantSummary.pass += 1;
        else covenantSummary.unknown += 1;

        const hp = status.evaluation.headroomPct;
        if (band !== 'UNKNOWN' && hp !== null) {
          if (!worstHeadroom || worstHeadroom.headroomPct === null || hp < worstHeadroom.headroomPct) {
            worstHeadroom = { loanName: row.loan_name, covenantType: row.covenant_type, headroomPct: hp, band };
          }
        }
      } catch {
        covenantSummary.unknown += 1;
      }
    }
  }

  return NextResponse.json({
    data: {
      loanCount: instruments.length,
      loansWithSchedule,
      totalOutstandingCents,
      currentPortionCents,
      nonCurrentPortionCents,
      nextPayment,
      debtService12Mo: {
        totalCents: serviceNext12MoCents,
        interestCents: interestNext12MoCents,
        principalCents: principalNext12MoCents,
      },
      covenants: {
        ...covenantSummary,
        worstHeadroom,
      },
    },
    meta: { locationId: locationId ?? null, consolidated: !locationId, asOfDate: todayIso },
  });
}
