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
    .from('organizations')
    .select('id, name, setup_complete')
    .limit(1)
    .single();

  if (!org) {
    return NextResponse.json({ setupComplete: false, step: 'organization' });
  }

  if (!org.setup_complete) {
    // Check how far they got
    const { count: locCount } = await supabase.from('locations').select('id', { count: 'exact', head: true });
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
});

// ─── Step 3: Seed COA ───────────────────────────────────────

const coaSchema = z.object({
  step: z.literal('chart_of_accounts'),
});

// ─── Step 4: Finalize ───────────────────────────────────────

const finalizeSchema = z.object({
  step: z.literal('finalize'),
});

const stepSchema = z.discriminatedUnion('step', [orgSchema, companySchema, coaSchema, finalizeSchema]);

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
    const { data: existing } = await supabase.from('organizations').select('id').limit(1).single();
    if (existing) {
      return NextResponse.json({ success: true, orgId: existing.id, message: 'Organization already exists' });
    }

    const { data: org, error } = await supabase
      .from('organizations')
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
    const { data: org } = await supabase.from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'Create organization first' }, { status: 400 });

    // Check for duplicate short_code
    const { data: existingLoc } = await supabase
      .from('locations')
      .select('id')
      .eq('short_code', body.short_code)
      .limit(1)
      .single();

    if (existingLoc) {
      return NextResponse.json({ error: `Short code "${body.short_code}" already exists` }, { status: 409 });
    }

    const { data: location, error: locErr } = await supabase
      .from('locations')
      .insert({
        org_id: org.id,
        name: body.name,
        short_code: body.short_code,
        industry: body.industry ?? null,
        fiscal_year_start_month: body.fiscal_year_start_month,
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

  if (body.step === 'chart_of_accounts') {
    const { data: org } = await supabase.from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'Create organization first' }, { status: 400 });

    // Check if COA already seeded
    const { count: existingAccounts } = await supabase
      .from('accounts')
      .select('id', { count: 'exact', head: true });

    if (existingAccounts && existingAccounts > 0) {
      return NextResponse.json({ success: true, message: 'Chart of accounts already exists', accountCount: existingAccounts });
    }

    let totalAccounts = 0;

    for (const typeData of ACCOUNT_TYPE_HIERARCHY) {
      // Insert account type
      const { data: acctType, error: typeErr } = await supabase
        .from('account_types')
        .insert({
          org_id: org.id,
          code: typeData.code,
          name: typeData.name,
          normal_balance: typeData.normal_balance,
          closes_to_retained_earnings: typeData.closes_to_retained_earnings,
          display_order: typeData.display_order,
        })
        .select('id')
        .single();

      if (typeErr || !acctType) {
        console.error(`[setup] Failed to insert account type ${typeData.code}:`, typeErr);
        continue;
      }

      for (const stData of typeData.sub_types) {
        // Insert sub-type
        const { data: subType, error: stErr } = await supabase
          .from('account_sub_types')
          .insert({
            org_id: org.id,
            account_type_id: acctType.id,
            code: stData.code,
            name: stData.name,
            display_order: stData.display_order,
          })
          .select('id')
          .single();

        if (stErr || !subType) {
          console.error(`[setup] Failed to insert sub-type ${stData.code}:`, stErr);
          continue;
        }

        for (const groupData of stData.groups) {
          // Insert group
          const { data: group, error: gErr } = await supabase
            .from('account_groups')
            .insert({
              org_id: org.id,
              account_sub_type_id: subType.id,
              name: groupData.name,
              display_order: groupData.display_order,
            })
            .select('id')
            .single();

          if (gErr || !group) {
            console.error(`[setup] Failed to insert group ${groupData.name}:`, gErr);
            continue;
          }

          // Insert accounts
          for (const acctData of groupData.accounts) {
            const { error: acctErr } = await supabase
              .from('accounts')
              .insert({
                org_id: org.id,
                account_group_id: group.id,
                account_number: acctData.number,
                name: acctData.name,
                account_type: typeData.code,
                display_order: acctData.display_order,
                is_control_account: acctData.is_control_account ?? false,
                is_company_specific: acctData.is_company_specific ?? false,
                is_bank_account: acctData.is_bank_account ?? false,
                is_credit_card: acctData.is_credit_card ?? false,
                require_department: acctData.require_department ?? false,
                require_class: acctData.require_class ?? false,
                approval_status: 'APPROVED',
                is_active: true,
              });

            if (acctErr) {
              console.error(`[setup] Failed to insert account ${acctData.number}:`, acctErr);
            } else {
              totalAccounts++;
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true, accountCount: totalAccounts }, { status: 201 });
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Finalize — mark setup complete
  // ═══════════════════════════════════════════════════════════

  if (body.step === 'finalize') {
    const { data: org } = await supabase.from('organizations').select('id').limit(1).single();
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    const { error } = await supabase
      .from('organizations')
      .update({ setup_complete: true })
      .eq('id', org.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, message: 'Setup complete!' });
  }

  return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
}
