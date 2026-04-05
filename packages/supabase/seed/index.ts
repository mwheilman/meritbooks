/**
 * Seed script for MeritBooks.
 *
 * Run with: npx tsx seed/index.ts
 *
 * Seeds in order:
 *   1. Organization
 *   2. Account type hierarchy (7 types → 11 sub-types → 71 groups)
 *   3. Accounts (251 from Merit Top Level COA)
 *   4. Locations (17 portfolio companies)
 *   5. Departments
 *   6. Demo fiscal periods
 */

import { createClient } from '@supabase/supabase-js';
import { ACCOUNT_TYPE_HIERARCHY } from '@meritbooks/shared';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  console.log('🌱 Seeding MeritBooks database...\n');

  // 1. Organization
  console.log('  [1/6] Organization...');
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .upsert({
      name: 'Merit Management Group',
      slug: 'merit-mgmt',
      primary_contact_name: 'Mike Wheilman',
      primary_contact_email: 'mike@meritmanagement.com',
      timezone: 'America/Chicago',
      fiscal_year_start_month: 1,
      setup_complete: true,
    }, { onConflict: 'slug' })
    .select()
    .single();

  if (orgErr) throw orgErr;
  const orgId = org.id;
  console.log(`    ✓ org_id = ${orgId}`);

  // 2. Account type hierarchy
  console.log('  [2/6] Account type hierarchy...');
  let typeCount = 0, subTypeCount = 0, groupCount = 0;

  for (const type of ACCOUNT_TYPE_HIERARCHY) {
    const { data: at, error: atErr } = await supabase
      .from('account_types')
      .upsert({
        org_id: orgId,
        name: type.name,
        code: type.code,
        display_order: type.display_order,
        normal_balance: type.normal_balance,
        closes_to_retained_earnings: type.closes_to_retained_earnings,
      }, { onConflict: 'org_id,code' })
      .select()
      .single();

    if (atErr) throw atErr;
    typeCount++;

    for (const st of type.sub_types) {
      const { data: ast, error: astErr } = await supabase
        .from('account_sub_types')
        .upsert({
          org_id: orgId,
          account_type_id: at.id,
          name: st.name,
          code: st.code,
          display_order: st.display_order,
        }, { onConflict: 'org_id,code' })
        .select()
        .single();

      if (astErr) throw astErr;
      subTypeCount++;

      for (const g of st.groups) {
        const { data: ag, error: agErr } = await supabase
          .from('account_groups')
          .upsert({
            org_id: orgId,
            account_sub_type_id: ast.id,
            name: g.name,
            display_order: g.display_order,
          }, { onConflict: 'org_id,name' })
          .select()
          .single();

        if (agErr) throw agErr;
        groupCount++;

        // 3. Accounts within this group
        for (const acct of g.accounts) {
          const { error: acctErr } = await supabase
            .from('accounts')
            .upsert({
              org_id: orgId,
              account_group_id: ag.id,
              account_number: acct.number,
              name: acct.name,
              account_type: type.code,
              account_sub_type: st.code,
              is_control_account: acct.is_control_account ?? false,
              is_company_specific: false, // top-level COA; per-location instances created during onboarding
              is_bank_account: acct.is_bank_account ?? false,
              is_credit_card: acct.is_credit_card ?? false,
              require_department: acct.require_department ?? false,
              require_class: acct.require_class ?? false,
              approval_status: 'APPROVED',
              display_order: acct.display_order,
            }, { onConflict: 'org_id,account_number' });

          if (acctErr) throw acctErr;
        }
      }
    }
  }

  const totalAccounts = ACCOUNT_TYPE_HIERARCHY.reduce((sum, t) =>
    sum + t.sub_types.reduce((s, st) =>
      s + st.groups.reduce((g, gr) => g + gr.accounts.length, 0), 0), 0);

  console.log(`    ✓ ${typeCount} types, ${subTypeCount} sub-types, ${groupCount} groups, ${totalAccounts} accounts`);

  // 4. Locations (portfolio companies)
  console.log('  [3/6] Portfolio companies...');
  const companies = [
    { name: 'Merit Management Group', short_code: 'MMG', industry: 'Holding Company' },
    { name: 'Swan Creek Construction', short_code: 'SCC', industry: 'Construction' },
    { name: 'Iowa Custom Cabinetry', short_code: 'ICC', industry: 'Cabinetry' },
    { name: 'Heartland HVAC', short_code: 'HH', industry: 'HVAC' },
    { name: 'Dorrian Mechanical', short_code: 'DM', industry: 'HVAC' },
    { name: 'Central Iowa Restoration', short_code: 'CIR', industry: 'Restoration' },
    { name: 'Artistry Interiors', short_code: 'AIN', industry: 'Construction' },
    { name: 'Williams Insulation', short_code: 'WI', industry: 'Insulation' },
    { name: 'Concrete Solutions', short_code: 'CS', industry: 'Concrete' },
    { name: 'Prairie Equipment', short_code: 'PE', industry: 'Equipment Sales' },
    { name: 'Metro Mechanical', short_code: 'MM', industry: 'HVAC' },
    { name: 'Midwest Comfort', short_code: 'MC', industry: 'HVAC' },
    { name: 'Allied Services', short_code: 'AS', industry: 'Construction' },
    { name: 'Summit Contractors', short_code: 'SC', industry: 'Construction' },
    { name: 'Heritage Homes', short_code: 'HHO', industry: 'Construction' },
    { name: 'Pioneer Plumbing', short_code: 'PP', industry: 'Plumbing' },
    { name: 'Cornerstone Build', short_code: 'CB', industry: 'Construction' },
  ];

  for (const co of companies) {
    const { error } = await supabase
      .from('locations')
      .upsert({
        org_id: orgId,
        name: co.name,
        short_code: co.short_code,
        industry: co.industry,
        fiscal_year_start_month: 1,
        gl_classification_default: co.short_code === 'MMG' ? 'ALWAYS_OPEX' : 'BY_JOB_MATCH',
        rev_rec_method: ['SCC', 'ICC', 'HH', 'DM', 'CIR'].includes(co.short_code) ? 'PCT_COSTS_INCURRED' : 'POINT_OF_SALE',
        minimum_cash_cents: 3000000, // $30K
        is_active: true,
      }, { onConflict: 'org_id,short_code' });

    if (error) throw error;
  }
  console.log(`    ✓ ${companies.length} companies`);

  // 5. Departments
  console.log('  [4/6] Departments...');
  const departments = [
    { name: 'Accounting', code: 'ACCT', gl_classification: 'ALWAYS_OPEX', clock_mode: 'MANUAL', require_gps: false },
    { name: 'Administration / HR', code: 'ADMIN', gl_classification: 'ALWAYS_OPEX', clock_mode: 'MANUAL', require_gps: false },
    { name: 'Marketing', code: 'MKT', gl_classification: 'ALWAYS_OPEX', clock_mode: 'MANUAL', require_gps: false },
    { name: 'IT', code: 'IT', gl_classification: 'ALWAYS_OPEX', clock_mode: 'MANUAL', require_gps: false },
    { name: 'Construction', code: 'CONST', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: true },
    { name: 'HVAC Service', code: 'HVAC', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: true },
    { name: 'Cabinetry', code: 'CAB', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: false },
    { name: 'Maintenance', code: 'MAINT', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: true },
    { name: 'Insulation', code: 'INS', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: true },
    { name: 'Restoration', code: 'REST', gl_classification: 'BY_JOB_MATCH', clock_mode: 'TIMER', require_gps: true },
  ];

  for (const dept of departments) {
    const { error } = await supabase
      .from('departments')
      .upsert({
        org_id: orgId,
        name: dept.name,
        code: dept.code,
        gl_classification: dept.gl_classification,
        clock_mode: dept.clock_mode,
        require_gps: dept.require_gps,
        require_phase: dept.gl_classification === 'BY_JOB_MATCH',
        billable_by_default: dept.gl_classification === 'BY_JOB_MATCH',
      }, { onConflict: 'org_id,code' });

    if (error) throw error;
  }
  console.log(`    ✓ ${departments.length} departments`);

  // 6. Fiscal periods (2026)
  console.log('  [5/6] Fiscal periods...');
  const { data: locations } = await supabase
    .from('locations')
    .select('id')
    .eq('org_id', orgId);

  let periodCount = 0;
  for (const loc of (locations ?? [])) {
    for (let month = 1; month <= 12; month++) {
      const startDate = `2026-${String(month).padStart(2, '0')}-01`;
      const endDate = new Date(2026, month, 0).toISOString().split('T')[0];

      const { error } = await supabase
        .from('fiscal_periods')
        .upsert({
          org_id: orgId,
          location_id: loc.id,
          period_year: 2026,
          period_month: month,
          start_date: startDate,
          end_date: endDate,
          status: month <= 2 ? 'HARD_CLOSE' : month === 3 ? 'SOFT_CLOSE' : 'OPEN',
        }, { onConflict: 'org_id,location_id,period_year,period_month' });

      if (error) throw error;
      periodCount++;
    }
  }
  console.log(`    ✓ ${periodCount} fiscal periods`);

  // 7. Compliance obligations
  console.log('  [6/6] Compliance obligations...');
  const obligations = [
    { name: 'Sales Tax', frequency: 'MONTHLY', jurisdiction: 'Iowa' },
    { name: 'Federal 940', frequency: 'ANNUALLY', jurisdiction: 'Federal' },
    { name: 'Federal 941', frequency: 'QUARTERLY', jurisdiction: 'Federal' },
    { name: 'State Withholding', frequency: 'MONTHLY', jurisdiction: 'Iowa' },
    { name: 'State UI', frequency: 'QUARTERLY', jurisdiction: 'Iowa' },
    { name: 'Property Tax', frequency: 'ANNUALLY', jurisdiction: 'Iowa' },
    { name: 'Monthly Financials', frequency: 'MONTHLY', jurisdiction: null },
  ];

  for (const ob of obligations) {
    const { error } = await supabase
      .from('compliance_obligations')
      .insert({ org_id: orgId, name: ob.name, frequency: ob.frequency, jurisdiction: ob.jurisdiction });

    if (error && !error.message.includes('duplicate')) throw error;
  }
  console.log(`    ✓ ${obligations.length} obligation types`);

  console.log('\n✅ Seed complete!\n');
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
