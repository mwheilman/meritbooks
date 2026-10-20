export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchDebtRegister } from '@/lib/debt/register';
import { getOrgToday } from '@/lib/dates/org-today';
import { daysBetweenIso, isIsoDate } from '@/lib/dates/org-date';

/**
 * Reports → Debt Schedule. Balances are the OUTSTANDING principal derived from the
 * amortization schedule as of `as_of_date` (default: today in the org's timezone)
 * — the same derivation /debt and the board package use (lib/debt/register), so
 * all three tie. The stored `current_balance_cents` is NOT used (it is stale).
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  const { searchParams } = new URL(request.url);
  const locationIds = (searchParams.get('location_ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const asOfParam = searchParams.get('as_of_date');
  const asOfDate = isIsoDate(asOfParam) ? asOfParam : await getOrgToday(supabase, orgId);

  let register;
  try {
    register = await fetchDebtRegister(supabase, { asOfDate, locationIds });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load debt' }, { status: 500 });
  }

  const instruments = register.instruments.map((d) => ({
    id: d.id,
    name: d.name,
    lender: d.lender,
    type: d.type,
    originalCents: d.originalCents,
    balanceCents: d.balanceCents,
    interestRate: d.interestRate,
    maturityDate: d.maturityDate,
    monthsRemaining: d.maturityDate ? Math.max(0, Math.round(daysBetweenIso(d.maturityDate, asOfDate) / 30)) : null,
    monthlyPaymentCents: d.monthlyPaymentCents,
    annualPaymentCents: d.annualPaymentCents,
    paymentType: d.paymentType,
    locationName: d.locationName,
    locationCode: d.locationCode,
  }));

  return NextResponse.json({
    data: instruments,
    summary: register.summary,
    asOfDate,
  });
}
