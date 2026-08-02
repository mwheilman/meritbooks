/**
 * Load the ACTIVE compiled expense-policy ruleset for an org (migration 086).
 *
 * The engine (`policy-engine.ts`) is pure and takes a ruleset; this is the thin,
 * RLS-scoped bridge that fetches the one ACTIVE policy row and validates its
 * `compiled_rules` jsonb against the fixed schema before it can drive enforcement.
 *
 * DEGRADE-SAFE (canon): if there is no active policy, the table doesn't exist yet,
 * the query errors, or the stored blob fails validation, this returns `null` and
 * the caller falls back to `DEFAULT_RULESET` (conservative, non-blocking). A
 * corrupt policy can therefore never block the expense flow.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseRuleset, type ExpensePolicyRuleset } from './policy-schema';

export interface ActivePolicy {
  policyId: string;
  name: string;
  version: number;
  ruleset: ExpensePolicyRuleset;
}

export async function loadActivePolicyRuleset(
  db: SupabaseClient,
  orgId: string
): Promise<ActivePolicy | null> {
  try {
    const { data, error } = await db
      .from('expense_policies')
      .select('id, name, version, compiled_rules')
      .eq('org_id', orgId)
      .eq('status', 'ACTIVE')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as { id: string; name: string; version: number; compiled_rules: unknown };
    const parsed = parseRuleset(row.compiled_rules);
    if (!parsed.ok) {
      console.error('[expense-policy] active policy failed schema validation:', parsed.errors.join('; '));
      return null;
    }
    return { policyId: row.id, name: row.name, version: row.version, ruleset: parsed.ruleset };
  } catch (e) {
    // Table may not exist yet (migration 086 not applied) — degrade to no policy.
    console.error('[expense-policy] loadActivePolicyRuleset failed (non-fatal):', e instanceof Error ? e.message : e);
    return null;
  }
}
