export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10);

  // Get obligations
  const { data: obligations, error: oblError } = await supabase
    .from('compliance_obligations')
    .select('id, name, frequency, jurisdiction')
    .order('name');

  if (oblError) return NextResponse.json({ error: oblError.message }, { status: 500 });

  // Get filings for this year
  const { data: filings, error: filError } = await supabase
    .from('compliance_filings')
    .select(`
      id, obligation_id, location_id, period_year, period_month, period_quarter,
      due_date, status, filed_amount_cents, expected_amount_cents,
      filed_by, filed_at, notes,
      location:locations!compliance_filings_location_id_fkey(id, name, short_code)
    `)
    .eq('period_year', year)
    .order('due_date');

  if (filError) return NextResponse.json({ error: filError.message }, { status: 500 });

  // Get locations
  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');

  const now = new Date();
  const filedCount = (filings ?? []).filter((f: Record<string, unknown>) => f.status === 'FILED' || f.status === 'AUTO_VERIFIED').length;
  const overdueCount = (filings ?? []).filter((f: Record<string, unknown>) => {
    const due = new Date(f.due_date as string);
    return f.status !== 'FILED' && f.status !== 'AUTO_VERIFIED' && due < now;
  }).length;
  const upcomingCount = (filings ?? []).filter((f: Record<string, unknown>) => {
    const due = new Date(f.due_date as string);
    const sevenDays = new Date(now);
    sevenDays.setDate(sevenDays.getDate() + 7);
    return f.status !== 'FILED' && f.status !== 'AUTO_VERIFIED' && due >= now && due <= sevenDays;
  }).length;

  return NextResponse.json({
    obligations: obligations ?? [],
    filings: (filings ?? []).map((f: Record<string, unknown>) => ({
      id: f.id,
      obligationId: f.obligation_id,
      locationId: f.location_id,
      periodYear: f.period_year,
      periodMonth: f.period_month,
      periodQuarter: f.period_quarter,
      dueDate: f.due_date,
      status: f.status,
      filedAmountCents: f.filed_amount_cents,
      expectedAmountCents: f.expected_amount_cents,
      filedAt: f.filed_at,
      notes: f.notes,
      location: f.location,
    })),
    locations: locations ?? [],
    summary: { filedCount, overdueCount, upcomingCount, totalFilings: (filings ?? []).length },
  });
}
