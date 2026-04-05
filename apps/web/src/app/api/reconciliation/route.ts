export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');

  let query = supabase
    .from('bank_reconciliations')
    .select(`
      id, statement_ending_balance_cents, gl_balance_cents,
      outstanding_deposits_cents, outstanding_checks_cents,
      adjusted_bank_balance_cents, difference_cents,
      is_reconciled, reconciled_by, created_at,
      bank_account:bank_accounts!bank_reconciliations_bank_account_id_fkey(id, account_name, account_number, current_balance_cents, account_type,
        location:locations!bank_accounts_location_id_fkey(id, name, short_code)
      ),
      fiscal_period:fiscal_periods!bank_reconciliations_fiscal_period_id_fkey(period_year, period_month, status)
    `)
    .order('created_at', { ascending: false });

  if (locationId) {
    // Filter by getting bank accounts for this location first
    const { data: accounts } = await supabase
      .from('bank_accounts')
      .select('id')
      .eq('location_id', locationId);
    if (accounts && accounts.length > 0) {
      query = query.in('bank_account_id', accounts.map((a) => a.id));
    }
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Also get bank accounts that need reconciliation (no rec for current period)
  const { data: allAccounts } = await supabase
    .from('bank_accounts')
    .select(`
      id, account_name, account_number, current_balance_cents, account_type,
      location:locations!bank_accounts_location_id_fkey(id, name, short_code)
    `)
    .eq('is_active', true);

  const reconciledAccountIds = new Set((data ?? []).map((r) => {
    const ba = Array.isArray(r.bank_account) ? r.bank_account[0] : r.bank_account;
    return ba?.id;
  }).filter(Boolean));

  const needsReconciliation = (allAccounts ?? []).filter((a) => !reconciledAccountIds.has(a.id));

  return NextResponse.json({
    reconciliations: (data ?? []).map((r) => {
      const ba = Array.isArray(r.bank_account) ? r.bank_account[0] : r.bank_account;
      const fp = Array.isArray(r.fiscal_period) ? r.fiscal_period[0] : r.fiscal_period;
      const loc = ba && typeof ba === 'object' && 'location' in ba
        ? (Array.isArray(ba.location) ? ba.location[0] : ba.location) : null;
      return {
        id: r.id,
        bankAccountName: ba?.account_name ?? '',
        bankAccountNumber: ba?.account_number ?? '',
        locationName: (loc as { name: string } | null)?.name ?? '',
        locationCode: (loc as { short_code: string } | null)?.short_code ?? '',
        periodYear: fp?.period_year,
        periodMonth: fp?.period_month,
        statementBalanceCents: Number(r.statement_ending_balance_cents),
        glBalanceCents: Number(r.gl_balance_cents),
        outstandingDepositsCents: Number(r.outstanding_deposits_cents),
        outstandingChecksCents: Number(r.outstanding_checks_cents),
        adjustedBankBalanceCents: Number(r.adjusted_bank_balance_cents),
        differenceCents: Number(r.difference_cents),
        isReconciled: r.is_reconciled,
      };
    }),
    needsReconciliation: needsReconciliation.map((a) => {
      const loc = Array.isArray(a.location) ? a.location[0] : a.location;
      return {
        id: a.id,
        accountName: a.account_name,
        accountNumber: a.account_number,
        balanceCents: Number(a.current_balance_cents),
        accountType: a.account_type,
        locationName: (loc as { name: string } | null)?.name ?? '',
        locationCode: (loc as { short_code: string } | null)?.short_code ?? '',
      };
    }),
  });
}

// ─── POST: Start reconciliation ───────────────────────────────────────
const startRecSchema = z.object({
  bank_account_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  statement_ending_balance_cents: z.number().int(),
  gl_balance_cents: z.number().int(),
  outstanding_deposits_cents: z.number().int().default(0),
  outstanding_checks_cents: z.number().int().default(0),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const orgId = authResult.orgId ?? '';
  const supabase = createAdminSupabase();

  try {
    const raw = await request.json();
    const result = startRecSchema.safeParse(raw);
    if (!result.success) return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });

    const body = result.data;
    const { data, error } = await supabase
      .from('bank_reconciliations')
      .insert({
        org_id: orgId,
        bank_account_id: body.bank_account_id,
        fiscal_period_id: body.fiscal_period_id,
        statement_ending_balance_cents: body.statement_ending_balance_cents,
        gl_balance_cents: body.gl_balance_cents,
        outstanding_deposits_cents: body.outstanding_deposits_cents,
        outstanding_checks_cents: body.outstanding_checks_cents,
      })
      .select('id, difference_cents, is_reconciled')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Error' }, { status: 500 });
  }
}
