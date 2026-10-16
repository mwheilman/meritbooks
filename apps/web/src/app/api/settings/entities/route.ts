export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createServerSupabase } from '@/lib/supabase/server';
import { seedChartOfAccounts } from '@/lib/services/coa-seed';
import { createCompany, REV_REC_METHODS } from '@/lib/companies/create-company';
import { z } from 'zod';

/**
 * Entity (company/location) administration for an existing tenant.
 *
 * GET  — list this org's entities with the fiscal-year + rev-rec config the
 *        report compiler and fiscal-period engine key off, plus the org's
 *        inherited base currency (per-entity currency is not yet a column — see
 *        the entity setup wizard note; entities inherit `organizations.home_currency`).
 * POST — the Entity Setup Wizard: create a new company via the single
 *        company-creation path (`lib/companies/create-company.ts` — fiscal periods
 *        for prior/current/next calendar year, prior months SOFT_CLOSE; short code
 *        derived from the name when omitted), and ensure the tenant's chart
 *        of accounts is seeded from the standard template (idempotent — reuses the
 *        single shared `seedChartOfAccounts` path, never a duplicated template).
 *
 * RLS-scoped throughout (createServerSupabase); gated on `settings_acct:edit`.
 */

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
    .eq('org_id', orgId)
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
  name: z.string().trim().min(1).max(200),
  // Optional: when omitted, createCompany derives a unique code from the name.
  short_code: z.string().trim().max(10).regex(/^[A-Z0-9]*$/, 'Short code must be uppercase letters/numbers').optional(),
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

  // 1+2. Create the entity and its fiscal periods through the single
  //      company-creation path (duplicate name/short code → 409; prior months
  //      SOFT_CLOSE, current/future OPEN).
  const created = await createCompany(supabase, {
    orgId,
    name: body.name,
    shortCode: body.short_code || null,
    industry: body.industry ?? null,
    fiscalYearStartMonth: body.fiscal_year_start_month,
    revRecMethod: body.rev_rec_method,
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });

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
    {
      success: true,
      locationId: created.locationId,
      shortCode: created.shortCode,
      periodsCreated: created.periodsCreated,
      accountCount,
    },
    { status: 201 },
  );
}
