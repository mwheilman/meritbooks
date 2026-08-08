export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createServerSupabase } from '@/lib/supabase/server';
import { seedChartOfAccounts } from '@/lib/services/coa-seed';
import { z } from 'zod';

/**
 * Entity (company/location) administration for an existing tenant.
 *
 * GET  — list this org's entities with the fiscal-year + rev-rec config the
 *        report compiler and fiscal-period engine key off, plus the org's
 *        inherited base currency (per-entity currency is not yet a column — see
 *        the entity setup wizard note; entities inherit `organizations.home_currency`).
 * POST — the Entity Setup Wizard: create a new company, auto-generate its fiscal
 *        periods (prior/current/next calendar year), and ensure the tenant's chart
 *        of accounts is seeded from the standard template (idempotent — reuses the
 *        single shared `seedChartOfAccounts` path, never a duplicated template).
 *
 * RLS-scoped throughout (createServerSupabase); gated on `settings_acct:edit`.
 */

const REV_REC_METHODS = [
  'POINT_OF_SALE', 'AS_BILLED', 'PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT',
  'MILESTONE', 'RATABLY', 'SUBSCRIPTION', 'CASH',
] as const;

export async function GET() {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const orgId = authResult.orgId ?? '';

  const supabase = await createServerSupabase();

  const { data: org } = await supabase
    .schema('core').from('organizations')
    .select('home_currency, fiscal_year_start_month')
    .eq('id', orgId)
    .maybeSingle();

  const { data: locations, error } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code, industry, fiscal_year_start_month, rev_rec_method, is_active, created_at')
    .order('name');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    baseCurrency: org?.home_currency ?? 'USD',
    orgFiscalYearStartMonth: org?.fiscal_year_start_month ?? 1,
    entities: (locations ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      shortCode: l.short_code,
      industry: l.industry,
      fiscalYearStartMonth: l.fiscal_year_start_month,
      revRecMethod: l.rev_rec_method,
      isActive: l.is_active,
      createdAt: l.created_at,
    })),
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  short_code: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Short code must be uppercase letters/numbers'),
  industry: z.string().max(100).optional(),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).default(1),
  rev_rec_method: z.enum(REV_REC_METHODS).default('POINT_OF_SALE'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';

  // Creating a new book-of-record entity mutates accounting configuration.
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  if (!orgId) return NextResponse.json({ error: 'No resolvable organization' }, { status: 400 });

  const raw = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });
  }
  const body = parsed.data;

  const supabase = await createServerSupabase();

  // Reject duplicate short_code within the tenant (also enforced by the unique
  // (org_id, short_code) constraint — this returns a friendlier 409).
  const { data: existing } = await supabase
    .schema('core').from('locations')
    .select('id')
    .eq('short_code', body.short_code)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: `Short code "${body.short_code}" already exists` }, { status: 409 });
  }

  // 1. Create the entity.
  const { data: location, error: locErr } = await supabase
    .schema('core').from('locations')
    .insert({
      org_id: orgId,
      name: body.name,
      short_code: body.short_code,
      industry: body.industry ?? null,
      fiscal_year_start_month: body.fiscal_year_start_month,
      rev_rec_method: body.rev_rec_method,
    })
    .select('id')
    .single();

  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });

  // 2. Auto-generate fiscal periods (prior + current + next calendar year).
  //    Mirrors the onboarding setup path so numbering/statuses never fork.
  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const periods = years.flatMap((year) =>
    Array.from({ length: 12 }, (_, i) => i + 1).map((month) => {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0);
      const periodDate = new Date(year, month - 1, 15);
      const isBeforeCurrentMonth = periodDate < new Date(now.getFullYear(), now.getMonth(), 1);
      const status = year < now.getFullYear() ? 'HARD_CLOSE' : isBeforeCurrentMonth ? 'SOFT_CLOSE' : 'OPEN';
      return {
        org_id: orgId,
        location_id: location.id,
        period_year: year,
        period_month: month,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        status,
      };
    }),
  );

  let periodsCreated = 0;
  const { error: periodErr } = await supabase.from('fiscal_periods').insert(periods);
  if (periodErr) {
    console.error('[entities] fiscal period error:', periodErr.message);
    // Non-fatal — the entity exists; periods can be regenerated from /periods.
  } else {
    periodsCreated = periods.length;
  }

  // 3. Ensure the tenant's chart of accounts exists (idempotent, self-healing,
  //    non-destructive). All entities in the org share the org-scoped COA, so
  //    this is a no-op once the first entity has seeded it.
  let accountCount = 0;
  try {
    const seedRes = await seedChartOfAccounts(supabase, orgId);
    accountCount = seedRes.totalAccounts;
  } catch (e) {
    console.error('[entities] COA seed error:', e instanceof Error ? e.message : e);
    // Non-fatal — the entity exists and can share the org COA once seeded.
  }

  return NextResponse.json(
    { success: true, locationId: location.id, periodsCreated, accountCount },
    { status: 201 },
  );
}
