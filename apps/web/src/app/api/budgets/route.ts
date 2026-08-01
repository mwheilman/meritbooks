export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';

// ─── GET: Budget entries pivoted by account (periods as columns) ──────────
// SECURITY: runs AS THE USER so org_isolation RLS enforces the tenant on every
// budget/account query (was previously on the RLS-bypassing admin client — the
// same cross-tenant leak class flagged in FPB-financial-reports Dimension 15).
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? String(new Date().getFullYear()), 10);
  const departmentId = searchParams.get('department_id'); // null/absent => company-level (dept IS NULL)

  let query = supabase
    .from('budgets')
    .select(`
      id, location_id, account_id, department_id, fiscal_year,
      period_number, amount_cents, notes,
      account:accounts!budgets_account_id_fkey(account_number, name, account_type)
    `)
    .eq('fiscal_year', fiscalYear)
    .order('account_id')
    .order('period_number');

  if (locationId) query = query.eq('location_id', locationId);
  // Scope to the chosen dimension: a specific department, or the company-level
  // (department_id IS NULL) budget. This keeps the entry grid unambiguous.
  if (departmentId) query = query.eq('department_id', departmentId);
  else query = query.is('department_id', null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Pivot: group by account, periods (1..13) as columns.
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
    const amt = Number(row.amount_cents);
    const existing = accountMap.get(key);
    if (existing) {
      existing.periods[row.period_number] = amt;
      existing.totalCents += amt;
    } else {
      accountMap.set(key, {
        accountId: row.account_id,
        accountNumber: acct.account_number,
        accountName: acct.name,
        accountType: acct.account_type,
        periods: { [row.period_number]: amt },
        totalCents: amt,
      });
    }
  }

  return NextResponse.json({
    fiscalYear,
    accounts: Array.from(accountMap.values()).sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
  });
}

// ─── POST: Bulk create/update (save the whole grid) ───────────────────────
const entrySchema = z.object({
  account_id: z.string().uuid(),
  period_number: z.number().int().min(1).max(13),
  amount_cents: z.number().int(),
});

const bulkSchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  department_id: z.string().uuid().optional().nullable(),
  entries: z.array(entrySchema).min(1),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });

  try {
    const raw = await request.json();
    const result = bulkSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }
    const body = result.data;

    const inserts = body.entries.map((e) => ({
      org_id: orgId,
      location_id: body.location_id,
      account_id: e.account_id,
      department_id: body.department_id ?? null,
      fiscal_year: body.fiscal_year,
      period_number: e.period_number,
      amount_cents: e.amount_cents,
      created_by: userId,
    }));

    const { error } = await supabase
      .from('budgets')
      .upsert(inserts, { onConflict: 'org_id,location_id,account_id,department_id,fiscal_year,period_number' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ saved: inserts.length }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

// ─── PATCH: update a single budget cell (inline grid edit) ────────────────
const cellSchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  account_id: z.string().uuid(),
  period_number: z.number().int().min(1).max(13),
  amount_cents: z.number().int(),
  department_id: z.string().uuid().optional().nullable(),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });

  try {
    const raw = await request.json();
    const result = cellSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }
    const b = result.data;

    const { error } = await supabase
      .from('budgets')
      .upsert({
        org_id: orgId,
        location_id: b.location_id,
        account_id: b.account_id,
        department_id: b.department_id ?? null,
        fiscal_year: b.fiscal_year,
        period_number: b.period_number,
        amount_cents: b.amount_cents,
        created_by: userId,
      }, { onConflict: 'org_id,location_id,account_id,department_id,fiscal_year,period_number' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
