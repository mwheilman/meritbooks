export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids'); // comma-separated

  let query = supabase
    .from('debt_instruments')
    .select(`
      id, name, lender, instrument_type, original_amount_cents, current_balance_cents,
      interest_rate, maturity_date, monthly_payment_cents, payment_type,
      location:locations!debt_instruments_location_id_fkey(id, name, short_code)
    `)
    .order('current_balance_cents', { ascending: false });

  if (locationIds) {
    query = query.in('location_id', locationIds.split(','));
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const instruments = (data ?? []).map((d) => {
    const loc = Array.isArray(d.location) ? d.location[0] : d.location;
    const now = new Date();
    const maturity = d.maturity_date ? new Date(d.maturity_date) : null;
    const monthsRemaining = maturity ? Math.max(0, Math.round((maturity.getTime() - now.getTime()) / (30 * 86400000))) : null;
    const annualPayment = d.monthly_payment_cents ? Number(d.monthly_payment_cents) * 12 : 0;

    return {
      id: d.id,
      name: d.name,
      lender: d.lender,
      type: d.instrument_type,
      originalCents: Number(d.original_amount_cents),
      balanceCents: Number(d.current_balance_cents),
      interestRate: Number(d.interest_rate),
      maturityDate: d.maturity_date,
      monthsRemaining,
      monthlyPaymentCents: Number(d.monthly_payment_cents ?? 0),
      annualPaymentCents: annualPayment,
      paymentType: d.payment_type,
      locationName: (loc as { name: string } | null)?.name ?? '',
      locationCode: (loc as { short_code: string } | null)?.short_code ?? '',
    };
  });

  const totalBalance = instruments.reduce((s, d) => s + d.balanceCents, 0);
  const totalMonthlyPayment = instruments.reduce((s, d) => s + d.monthlyPaymentCents, 0);
  const weightedRate = totalBalance > 0
    ? instruments.reduce((s, d) => s + d.interestRate * d.balanceCents, 0) / totalBalance
    : 0;

  return NextResponse.json({
    data: instruments,
    summary: {
      totalBalanceCents: totalBalance,
      totalMonthlyPaymentCents: totalMonthlyPayment,
      instrumentCount: instruments.length,
      weightedAvgRate: Math.round(weightedRate * 100) / 100,
    },
  });
}
