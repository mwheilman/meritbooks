/**
 * Debt register as of a date — instruments with their OUTSTANDING balance derived
 * from the amortization schedule (lib/debt/outstanding), never the stale
 * `debt_instruments.current_balance_cents` (which is written once at creation and
 * still equals original principal on live loans). Shared by the board package and
 * the Reports → Debt Schedule route so both tie to /debt. RLS-scoped, read-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCoreMap } from '@/lib/stitch-core';
import { fetchAllIn } from '@/lib/supabase/fetch-all';
import { scheduledOutstandingAsOf, type DebtScheduleLine } from './outstanding';

export interface RegisterInstrument {
  id: string;
  name: string;
  lender: string;
  type: string;
  status: string;
  originalCents: number;
  /** Outstanding principal as of `asOfDate` (schedule-derived). */
  balanceCents: number;
  interestRate: number;
  maturityDate: string | null;
  monthlyPaymentCents: number;
  annualPaymentCents: number;
  paymentType: string | null;
  locationId: string | null;
  locationName: string;
  locationCode: string;
  fromSchedule: boolean;
}

export interface DebtRegister {
  asOfDate: string;
  instruments: RegisterInstrument[];
  summary: {
    totalBalanceCents: number;
    /** Monthly service of instruments that still carry a balance. */
    totalMonthlyPaymentCents: number;
    /** Instruments with an outstanding balance > 0. */
    instrumentCount: number;
    /** Balance-weighted average rate (percent, 2dp). */
    weightedAvgRate: number;
  };
}

interface InstrumentDbRow {
  id: string;
  name: string | null;
  lender: string | null;
  instrument_type: string | null;
  status: string | null;
  original_amount_cents: number | string | null;
  interest_rate: number | string | null;
  maturity_date: string | null;
  monthly_payment_cents: number | string | null;
  payment_type: string | null;
  location_id: string | null;
  origination_date: string | null;
}

/** Pure summary over register instruments (exported for tests). */
export function summarizeRegister(instruments: readonly RegisterInstrument[]): DebtRegister['summary'] {
  const live = instruments.filter((d) => d.balanceCents > 0);
  const totalBalance = live.reduce((s, d) => s + d.balanceCents, 0);
  const totalMonthly = live.reduce((s, d) => s + d.monthlyPaymentCents, 0);
  const weighted = totalBalance > 0 ? live.reduce((s, d) => s + d.interestRate * d.balanceCents, 0) / totalBalance : 0;
  return {
    totalBalanceCents: totalBalance,
    totalMonthlyPaymentCents: totalMonthly,
    instrumentCount: live.length,
    weightedAvgRate: Math.round(weighted * 100) / 100,
  };
}

export async function fetchDebtRegister(
  supabase: SupabaseClient,
  opts: { asOfDate: string; locationIds: readonly string[] },
): Promise<DebtRegister> {
  let q = supabase
    .from('debt_instruments')
    .select(
      'id, name, lender, instrument_type, status, original_amount_cents, interest_rate, maturity_date, monthly_payment_cents, payment_type, location_id, origination_date',
    );
  if (opts.locationIds.length > 0) q = q.in('location_id', [...opts.locationIds]);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  // Instruments originated after the as-of date did not exist yet.
  const rows = ((data ?? []) as unknown as InstrumentDbRow[]).filter(
    (r) => !r.origination_date || r.origination_date <= opts.asOfDate,
  );

  const linesById = new Map<string, DebtScheduleLine[]>();
  if (rows.length > 0) {
    const { data: lines } = await fetchAllIn(
      rows.map((r) => r.id),
      (chunk) =>
        supabase
          .from('debt_schedule_lines')
          .select('id, instrument_id, period, period_date, payment_cents, interest_cents, principal_cents, principal_balance_cents')
          .in('instrument_id', chunk),
      { label: 'debt-register debt_schedule_lines' },
    );
    for (const l of (lines ?? []) as unknown as Array<DebtScheduleLine & { instrument_id: string }>) {
      const arr = linesById.get(l.instrument_id) ?? [];
      arr.push({
        period: Number(l.period),
        period_date: l.period_date,
        payment_cents: Number(l.payment_cents ?? 0),
        interest_cents: Number(l.interest_cents ?? 0),
        principal_cents: Number(l.principal_cents ?? 0),
        principal_balance_cents: Number(l.principal_balance_cents ?? 0),
      });
      linesById.set(l.instrument_id, arr);
    }
  }

  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase,
    'locations',
    'id, name, short_code',
    rows.map((r) => r.location_id as string).filter(Boolean),
  );

  const instruments: RegisterInstrument[] = rows.map((r) => {
    const original = Number(r.original_amount_cents ?? 0);
    const status = r.status ?? 'ACTIVE';
    const derived = scheduledOutstandingAsOf(linesById.get(r.id) ?? [], opts.asOfDate, original);
    // A paid-off / refinanced / closed loan carries no balance regardless of schedule.
    const balance = status === 'ACTIVE' ? derived.outstandingCents : 0;
    const loc = r.location_id ? locMap.get(r.location_id) ?? null : null;
    const monthly = Number(r.monthly_payment_cents ?? 0);
    return {
      id: r.id,
      name: r.name ?? '',
      lender: r.lender ?? '',
      type: r.instrument_type ?? '',
      status,
      originalCents: original,
      balanceCents: balance,
      interestRate: Number(r.interest_rate ?? 0),
      maturityDate: r.maturity_date,
      monthlyPaymentCents: monthly,
      annualPaymentCents: monthly * 12,
      paymentType: r.payment_type,
      locationId: r.location_id,
      locationName: loc?.name ?? '',
      locationCode: loc?.short_code ?? '',
      fromSchedule: derived.fromSchedule,
    };
  });
  instruments.sort((a, b) => b.balanceCents - a.balanceCents);

  return { asOfDate: opts.asOfDate, instruments, summary: summarizeRegister(instruments) };
}
