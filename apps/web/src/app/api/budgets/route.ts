export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

// ─── GET: Budget entries ──────────────────────────────────────────────
export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? String(new Date().getFullYear()), 10);

  let query = supabase
    .from('budgets')
    .select(`
      id, location_id, account_id, department_id, fiscal_year,
      period_number, amount_cents, notes,
      account:accounts!budgets_account_id_fkey(account_number, name, account_type),
      location:locations!budgets_location_id_fkey(name, short_code)
    `)
    .eq('fiscal_year', fiscalYear)
    .order('period_number')
    .order('account_id');

  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pivot: group by account, periods as columns
  const accountMap = new Map<string, {
    accountId: string;
    accountNumber: string;
    accountName: string;
    accountType: string;
    periods: Record<number, number>;
    totalCents: number;
  }>();

  for (const row of data ?? []) {
    const acct = Array.isArray(row.account) ? row.account[0] : row.account;
    if (!acct) continue;
    const key = row.account_id;
    const existing = accountMap.get(key);
    const amt = Number(row.amount_cents);
    if (existing) {
      existing.periods[row.period_number] = amt;
      existing.totalCents += amt;
    } else {
      const periods: Record<number, number> = {};
      periods[row.period_number] = amt;
      accountMap.set(key, {
        accountId: row.account_id,
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        periods,
        totalCents: amt,
      });
    }
  }

  return NextResponse.json({
    fiscalYear,
    accounts: Array.from(accountMap.values()).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
  });
}

// ─── POST: Create/update budget entries ───────────────────────────────
const budgetEntrySchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  entries: z.array(z.object({
    account_id: z.string().uuid(),
    period_number: z.number().int().min(1).max(13),
    amount_cents: z.number().int(),
    department_id: z.string().uuid().optional().nullable(),
  })).min(1),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const orgId = authResult.orgId ?? '';
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  try {
    const raw = await request.json();
    const result = budgetEntrySchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }

    const body = result.data;

    // Upsert budget entries
    const inserts = body.entries.map((e) => ({
      org_id: orgId,
      location_id: body.location_id,
      account_id: e.account_id,
      department_id: e.department_id ?? null,
      fiscal_year: body.fiscal_year,
      period_number: e.period_number,
      amount_cents: e.amount_cents,
      created_by: userId,
    }));

    const { error } = await supabase
      .from('budgets')
      .upsert(inserts, {
        onConflict: 'org_id,location_id,account_id,department_id,fiscal_year,period_number',
      });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ saved: inserts.length }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
