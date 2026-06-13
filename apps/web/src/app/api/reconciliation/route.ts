export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

/**
 * GET /api/reconciliation
 *
 * NOTE (Session 25 fix): bank_accounts lives in `public` and locations lives in
 * `core`. PostgREST cannot embed across the core↔public boundary — attempting
 * `location:locations!bank_accounts_location_id_fkey(...)` throws
 * "Could not find a relationship between 'bank_accounts' and 'locations' in the
 * schema cache". Per the standing architecture rule, we select `location_id`
 * and stitch the entity (name / short_code) from `core.locations` in JS.
 */
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
      bank_account:bank_accounts!bank_reconciliations_bank_account_id_fkey(id, account_name, account_mask, current_balance_cents, account_type, location_id),
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
    } else {
      // No accounts for this entity → no reconciliations to show.
      query = query.in('bank_account_id', ['00000000-0000-0000-0000-000000000000']);
    }
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Bank accounts that need reconciliation (no rec for current period).
  const { data: allAccounts, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, current_balance_cents, account_type, location_id')
    .eq('is_active', true);
  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 });

  // ── Stitch entity (core.locations) in JS — cross-schema embeds don't work. ──
  const locationIds = new Set<string>();
  for (const r of data ?? []) {
    const ba = Array.isArray(r.bank_account) ? r.bank_account[0] : r.bank_account;
    const lid = (ba as { location_id?: string | null } | null)?.location_id;
    if (lid) locationIds.add(lid);
  }
  for (const a of allAccounts ?? []) {
    if (a.location_id) locationIds.add(a.location_id as string);
  }

  const locMap = new Map<string, { name: string; short_code: string }>();
  if (locationIds.size > 0) {
    const { data: locs } = await supabase
      .schema('core').from('locations')
      .select('id, name, short_code')
      .in('id', Array.from(locationIds));
    for (const l of locs ?? []) {
      locMap.set(l.id as string, { name: l.name as string, short_code: l.short_code as string });
    }
  }

  const reconciledAccountIds = new Set(
    (data ?? [])
      .map((r) => {
        const ba = Array.isArray(r.bank_account) ? r.bank_account[0] : r.bank_account;
        return (ba as { id?: string } | null)?.id;
      })
      .filter(Boolean)
  );

  const needsReconciliation = (allAccounts ?? []).filter((a) => !reconciledAccountIds.has(a.id));

  return NextResponse.json({
    reconciliations: (data ?? []).map((r) => {
      const ba = Array.isArray(r.bank_account) ? r.bank_account[0] : r.bank_account;
      const fp = Array.isArray(r.fiscal_period) ? r.fiscal_period[0] : r.fiscal_period;
      const lid = (ba as { location_id?: string | null } | null)?.location_id ?? null;
      const loc = lid ? locMap.get(lid) ?? null : null;
      return {
        id: r.id,
        bankAccountName: (ba as { account_name?: string } | null)?.account_name ?? '',
        bankAccountNumber: (ba as { account_mask?: string } | null)?.account_mask ?? '',
        locationName: loc?.name ?? '',
        locationCode: loc?.short_code ?? '',
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
      const loc = a.location_id ? locMap.get(a.location_id as string) ?? null : null;
      return {
        id: a.id,
        accountName: a.account_name,
        accountNumber: (a as { account_mask?: string }).account_mask ?? '',
        balanceCents: Number(a.current_balance_cents),
        accountType: a.account_type,
        locationId: a.location_id ?? null,
        locationName: loc?.name ?? '',
        locationCode: loc?.short_code ?? '',
      };
    }),
  });
}

// ─── POST: Start reconciliation ───────────────────────────────────────
// gl_balance_cents is COMPUTED server-side (running balance of the bank
// account's GL cash account through the period end), not trusted from the
// client. adjusted_bank_balance and difference are generated columns.
const startRecSchema = z.object({
  bank_account_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  statement_ending_balance_cents: z.number().int(),
  outstanding_deposits_cents: z.number().int().min(0).default(0),
  outstanding_checks_cents: z.number().int().min(0).default(0),
});

export async function POST(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase
    .schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  try {
    const raw = await request.json();
    const result = startRecSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }
    const body = result.data;

    // Resolve the bank account → its GL cash account + location.
    const { data: ba, error: baErr } = await supabase
      .from('bank_accounts')
      .select('id, account_id, location_id')
      .eq('id', body.bank_account_id)
      .eq('org_id', orgId)
      .single();
    if (baErr || !ba) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });

    // Resolve the fiscal period → its end date (the "as of" reconciliation date).
    const { data: period, error: pErr } = await supabase
      .from('fiscal_periods')
      .select('id, end_date, location_id')
      .eq('id', body.fiscal_period_id)
      .eq('org_id', orgId)
      .single();
    if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });

    // Compute the GL cash balance as of the period end: sum(debits) - sum(credits)
    // over POSTED entries dated on/before end_date, for this account + location.
    const { data: postedEntries } = await supabase
      .from('gl_entries')
      .select('id')
      .eq('org_id', orgId)
      .eq('location_id', ba.location_id)
      .eq('status', 'POSTED')
      .lte('entry_date', period.end_date);
    const entryIds = (postedEntries ?? []).map((e: { id: string }) => e.id);

    let glBalanceCents = 0;
    if (entryIds.length > 0) {
      const { data: lines } = await supabase
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .eq('account_id', ba.account_id)
        .in('gl_entry_id', entryIds);
      for (const l of lines ?? []) {
        glBalanceCents += Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0);
      }
    }

    const adjusted =
      body.statement_ending_balance_cents + body.outstanding_deposits_cents - body.outstanding_checks_cents;
    const difference = glBalanceCents - adjusted;

    const { data, error } = await supabase
      .from('bank_reconciliations')
      .insert({
        org_id: orgId,
        bank_account_id: body.bank_account_id,
        fiscal_period_id: body.fiscal_period_id,
        statement_ending_balance_cents: body.statement_ending_balance_cents,
        gl_balance_cents: glBalanceCents,
        outstanding_deposits_cents: body.outstanding_deposits_cents,
        outstanding_checks_cents: body.outstanding_checks_cents,
        is_reconciled: difference === 0,
      })
      .select('id, gl_balance_cents, difference_cents, is_reconciled')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Error' }, { status: 500 });
  }
}
