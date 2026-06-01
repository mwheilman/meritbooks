export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { ACCOUNT_TYPE_HIERARCHY } from '@meritbooks/shared';
import { z } from 'zod';

/**
 * GET /api/setup
 * Returns setup status — is there an org with setup_complete = true?
 */
export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase
    .schema('core').from('organizations')
    .select('id, name, setup_complete')
    .limit(1)
    .single();

  if (!org) {
    return NextResponse.json({ setupComplete: false, step: 'organization' });
  }

  if (!org.setup_complete) {
    // Check how far they got
    const { count: locCount } = await supabase.schema('core').from('locations').select('id', { count: 'exact', head: true });
    const { count: acctCount } = await supabase.from('accounts').select('id', { count: 'exact', head: true });

    let step = 'organization';
    if (locCount && locCount > 0) step = 'accounts';
    if (acctCount && acctCount > 0) step = 'banking';

    return NextResponse.json({ setupComplete: false, orgId: org.id, orgName: org.name, step, locationCount: locCount ?? 0, accountCount: acctCount ?? 0 });
  }

  return NextResponse.json({ setupComplete: true, orgId: org.id, orgName: org.name });
}

// ─── Step 1: Create Organization ────────────────────────────

const orgSchema = z.object({
  step: z.literal('organization'),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and dashes'),
  contact_name: z.string().max(200).optional(),
  contact_email: z.string().email().optional(),
  timezone: z.string().default('America/Chicago'),
});

// ─── Step 2: Create First Company ───────────────────────────

const companySchema = z.object({
  step: z.literal('company'),
  name: z.string().min(1).max(200),
  short_code: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Must be uppercase'),
  industry: z.string().max(100).optional(),
  fiscal_year_start_month: z.number().int().min(1).max(12).default(1),
  // Rev-rec is a per-company wizard setting (FROZEN contract §1); Books drives
  // recognition from it. Defaults to point-of-sale.
  rev_rec_method: z.enum(['PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'POINT_OF_SALE']).default('POINT_OF_SALE'),
});

// ─── Step 3: Seed COA ───────────────────────────────────────

const coaSchema = z.object({
  step: z.literal('chart_of_accounts'),
});

// ─── Step 4: Finalize ───────────────────────────────────────

const finalizeSchema = z.object({
  step: z.literal('finalize'),
});

// ─── Step: Set company default internal charge method ───────

const chargeMethodSchema = z.object({
  step: z.literal('company_charge_method'),
  location_id: z.string().uuid(),
  default_internal_charge_method: z.enum(['revenue', 'cost_transfer']),
});

const stepSchema = z.discriminatedUnion('step', [orgSchema, companySchema, chargeMethodSchema, coaSchema, finalizeSchema]);

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  let body: z.infer<typeof stepSchema>;
  try {
    const raw = await request.json();
    const result = stepSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({
        error: 'Validation failed',
        details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      }, { status: 422 });
    }
    body = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 1: Create Organization
  // ═══════════════════════════════════════════════════════════

  if (body.step === 'organization') {
    // Check if org already exists
    const { data: existing } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
    if (existing) {
      return NextResponse.json({ success: true, orgId: existing.id, message: 'Organization already exists' });
    }

    const { data: org, error } = await supabase
      .schema('core').from('organizations')
      .insert({
        name: body.name,
        slug: body.slug,
        primary_contact_name: body.contact_name ?? null,
        primary_contact_email: body.contact_email ?? null,
        timezone: body.timezone,
        setup_complete: false,
      })
      .select('id')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, orgId: org.id }, { status: 201 });
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 2: Create Company + Fiscal Periods
  // ═══════════════════════════════════════════════════════════

  if (body.step === 'company') {
    const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'Create organization first' }, { status: 400 });

    // Check for duplicate short_code
    const { data: existingLoc } = await supabase
      .schema('core').from('locations')
      .select('id')
      .eq('short_code', body.short_code)
      .limit(1)
      .single();

    if (existingLoc) {
      return NextResponse.json({ error: `Short code "${body.short_code}" already exists` }, { status: 409 });
    }

    const { data: location, error: locErr } = await supabase
      .schema('core').from('locations')
      .insert({
        org_id: org.id,
        name: body.name,
        short_code: body.short_code,
        industry: body.industry ?? null,
        fiscal_year_start_month: body.fiscal_year_start_month,
        rev_rec_method: body.rev_rec_method,
      })
      .select('id')
      .single();

    if (locErr) {
      return NextResponse.json({ error: locErr.message }, { status: 500 });
    }

    // Auto-generate fiscal periods for prior year + current year + next year
    const now = new Date();
    const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    const periods: Array<{
      org_id: string;
      location_id: string;
      period_year: number;
      period_month: number;
      start_date: string;
      end_date: string;
      status: string;
    }> = [];

    for (const year of years) {
      for (let month = 1; month <= 12; month++) {
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0); // Last day of month

        // Prior year periods are HARD_CLOSE, current month is OPEN, future is OPEN
        const periodDate = new Date(year, month - 1, 15);
        const isBeforeCurrentMonth = periodDate < new Date(now.getFullYear(), now.getMonth(), 1);
        const status = year < now.getFullYear() ? 'HARD_CLOSE' : isBeforeCurrentMonth ? 'SOFT_CLOSE' : 'OPEN';

        periods.push({
          org_id: org.id,
          location_id: location.id,
          period_year: year,
          period_month: month,
          start_date: startDate.toISOString().split('T')[0],
          end_date: endDate.toISOString().split('T')[0],
          status,
        });
      }
    }

    const { error: periodErr } = await supabase.from('fiscal_periods').insert(periods);
    if (periodErr) {
      console.error('[setup] Fiscal period error:', periodErr);
      // Non-fatal — company was created
    }

    return NextResponse.json({
      success: true,
      locationId: location.id,
      periodsCreated: periods.length,
    }, { status: 201 });
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Seed Chart of Accounts from CFO Spec
  // ═══════════════════════════════════════════════════════════

  if (body.step === 'company_charge_method') {
    const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'Create organization first' }, { status: 400 });
    const { error } = await supabase
      .schema('core').from('locations')
      .update({ default_internal_charge_method: body.default_internal_charge_method })
      .eq('id', body.location_id)
      .eq('org_id', org.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (body.step === 'chart_of_accounts') {
    const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'Create organization first' }, { status: 400 });
    const orgId = org.id;

    // ─────────────────────────────────────────────────────────
    // Seed this tenant's own editable copy of the standard chart.
    //
    // Each tenant owns its own account rows (scoped by org_id) — this is
    // NOT a shared global table. We copy the full standard template into
    // the tenant's accounts at setup; the tenant then reviews/amends it.
    //
    // Done as a handful of bulk UPSERTs (not ~340 sequential inserts) so
    // the request can never time out partway, and so it is idempotent and
    // self-healing: a partially-seeded tenant (e.g. types/sub-types/groups
    // present but accounts missing) is repaired on the next run. Existing
    // accounts are left untouched (ignoreDuplicates) so tenant edits and
    // any company-specific accounts survive a re-run.
    // ─────────────────────────────────────────────────────────

    // 1. Account types — upsert by (org_id, code), then read ids back
    const typeRows = ACCOUNT_TYPE_HIERARCHY.map((t) => ({
      org_id: orgId,
      code: t.code,
      name: t.name,
      normal_balance: t.normal_balance,
      closes_to_retained_earnings: t.closes_to_retained_earnings,
      display_order: t.display_order,
    }));
    const { error: typeErr } = await supabase
      .from('account_types')
      .upsert(typeRows, { onConflict: 'org_id,code' });
    if (typeErr) {
      console.error('[setup] account_types upsert failed:', typeErr);
      return NextResponse.json({ error: `Failed seeding account types: ${typeErr.message}` }, { status: 500 });
    }
    const { data: typeRowsBack } = await supabase
      .from('account_types')
      .select('id, code')
      .eq('org_id', orgId);
    const typeIdByCode = new Map((typeRowsBack ?? []).map((r) => [r.code as string, r.id as string]));

    // 2. Sub-types — upsert by (org_id, code)
    const subRows: Array<Record<string, unknown>> = [];
    for (const t of ACCOUNT_TYPE_HIERARCHY) {
      for (const st of t.sub_types) {
        subRows.push({
          org_id: orgId,
          account_type_id: typeIdByCode.get(t.code),
          code: st.code,
          name: st.name,
          display_order: st.display_order,
        });
      }
    }
    const { error: subErr } = await supabase
      .from('account_sub_types')
      .upsert(subRows, { onConflict: 'org_id,code' });
    if (subErr) {
      console.error('[setup] account_sub_types upsert failed:', subErr);
      return NextResponse.json({ error: `Failed seeding sub-types: ${subErr.message}` }, { status: 500 });
    }
    const { data: subRowsBack } = await supabase
      .from('account_sub_types')
      .select('id, code')
      .eq('org_id', orgId);
    const subIdByCode = new Map((subRowsBack ?? []).map((r) => [r.code as string, r.id as string]));

    // 3. Account groups — upsert by (org_id, name)
    const groupRows: Array<Record<string, unknown>> = [];
    for (const t of ACCOUNT_TYPE_HIERARCHY) {
      for (const st of t.sub_types) {
        for (const g of st.groups) {
          groupRows.push({
            org_id: orgId,
            account_sub_type_id: subIdByCode.get(st.code),
            name: g.name,
            display_order: g.display_order,
          });
        }
      }
    }
    const { error: groupErr } = await supabase
      .from('account_groups')
      .upsert(groupRows, { onConflict: 'org_id,name' });
    if (groupErr) {
      console.error('[setup] account_groups upsert failed:', groupErr);
      return NextResponse.json({ error: `Failed seeding account groups: ${groupErr.message}` }, { status: 500 });
    }
    const { data: groupRowsBack } = await supabase
      .from('account_groups')
      .select('id, name')
      .eq('org_id', orgId);
    const groupIdByName = new Map((groupRowsBack ?? []).map((r) => [r.name as string, r.id as string]));

    // 4. Accounts — one bulk upsert; ignoreDuplicates keeps existing rows intact
    const accountRows: Array<Record<string, unknown>> = [];
    for (const t of ACCOUNT_TYPE_HIERARCHY) {
      for (const st of t.sub_types) {
        for (const g of st.groups) {
          for (const acctData of g.accounts) {
            accountRows.push({
              org_id: orgId,
              account_group_id: groupIdByName.get(g.name),
              account_number: acctData.number,
              name: acctData.name,
              account_type: t.code,
              account_sub_type: st.code,
              display_order: acctData.display_order,
              is_control_account: acctData.is_control_account ?? false,
              // Template accounts are org-level and non-company-specific;
              // company_location_id stays null to satisfy chk_company_specific.
              is_company_specific: false,
              company_location_id: null,
              is_bank_account: acctData.is_bank_account ?? false,
              is_credit_card: acctData.is_credit_card ?? false,
              require_department: acctData.require_department ?? false,
              require_class: acctData.require_class ?? false,
              approval_status: 'APPROVED',
              is_active: true,
            });
          }
        }
      }
    }
    const { error: acctErr } = await supabase
      .from('accounts')
      .upsert(accountRows, { onConflict: 'org_id,account_number', ignoreDuplicates: true });
    if (acctErr) {
      console.error('[setup] accounts upsert failed:', acctErr);
      return NextResponse.json({ error: `Failed seeding accounts: ${acctErr.message}` }, { status: 500 });
    }

    const { count: totalAccounts } = await supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);

    return NextResponse.json(
      { success: true, accountCount: totalAccounts ?? 0, templateAccounts: accountRows.length },
      { status: 201 },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Finalize — mark setup complete
  // ═══════════════════════════════════════════════════════════

  if (body.step === 'finalize') {
    const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    const { error } = await supabase
      .schema('core').from('organizations')
      .update({ setup_complete: true })
      .eq('id', org.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, message: 'Setup complete!' });
  }

  return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
}
