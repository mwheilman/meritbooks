/**
 * Chart-of-accounts seeding — the single, shared seeding path.
 *
 * Extracted verbatim from the setup wizard's `chart_of_accounts` step so that
 * BOTH onboarding and the sandbox seed use the exact same idempotent code. This
 * is a hard requirement of the seeded-test-tenant definition: testing the
 * sandbox must also test the real onboarding seed.
 *
 * Properties (unchanged from the wizard):
 *  - Per-tenant: each org owns its own editable copy of the standard chart
 *    (scoped by org_id). NOT a shared global table, NOT per-location.
 *  - Idempotent + self-healing: a partially-seeded tenant (types/sub-types/
 *    groups present, accounts missing) is repaired on the next run.
 *  - Non-destructive: `ignoreDuplicates` on accounts preserves edited and
 *    company-specific rows on a re-run.
 *  - No timeout: ~9 bulk UPSERT round-trips, never ~340 sequential inserts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ACCOUNT_TYPE_HIERARCHY } from '@meritbooks/shared';

type DB = SupabaseClient;

export interface CoaSeedResult {
  templateAccounts: number;
  totalAccounts: number;
}

/**
 * Seed (or repair) this tenant's chart of accounts from the standard template.
 * Throws on failure with a descriptive message.
 */
export async function seedChartOfAccounts(db: DB, orgId: string): Promise<CoaSeedResult> {
  // 1. Account types — upsert by (org_id, code), then read ids back
  const typeRows = ACCOUNT_TYPE_HIERARCHY.map((t) => ({
    org_id: orgId,
    code: t.code,
    name: t.name,
    normal_balance: t.normal_balance,
    closes_to_retained_earnings: t.closes_to_retained_earnings,
    display_order: t.display_order,
  }));
  const { error: typeErr } = await db
    .from('account_types')
    .upsert(typeRows, { onConflict: 'org_id,code' });
  if (typeErr) throw new Error(`Failed seeding account types: ${typeErr.message}`);

  const { data: typeRowsBack } = await db
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
  const { error: subErr } = await db
    .from('account_sub_types')
    .upsert(subRows, { onConflict: 'org_id,code' });
  if (subErr) throw new Error(`Failed seeding sub-types: ${subErr.message}`);

  const { data: subRowsBack } = await db
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
  const { error: groupErr } = await db
    .from('account_groups')
    .upsert(groupRows, { onConflict: 'org_id,name' });
  if (groupErr) throw new Error(`Failed seeding account groups: ${groupErr.message}`);

  const { data: groupRowsBack } = await db
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
  const { error: acctErr } = await db
    .from('accounts')
    .upsert(accountRows, { onConflict: 'org_id,account_number', ignoreDuplicates: true });
  if (acctErr) throw new Error(`Failed seeding accounts: ${acctErr.message}`);

  const { count: totalAccounts } = await db
    .from('accounts')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);

  return { templateAccounts: accountRows.length, totalAccounts: totalAccounts ?? 0 };
}
