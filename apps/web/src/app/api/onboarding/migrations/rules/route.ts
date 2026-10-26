export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { rulesQuery } from '@/lib/validations/onboarding-migration';
import { guardMigration, migrationErrorResponse, noOrg } from '@/lib/onboarding/migration/server/guard';
import { loadRuleLibrary } from '@/lib/onboarding/migration/server/mapping';

/**
 * GET /api/onboarding/migrations/rules?set_id= — the firm's mapping memory: sets, rules,
 * evidence per client (only clients in the caller's scope), conflicts first.
 * Gate: journal_entries:view. Settling a rule is POST /mapping {action: settle_rule}.
 */
export const GET = apiQueryHandler(rulesQuery, async (q, { userId, orgId, supabase }) => {
  const g = await guardMigration(userId, 'view', '/api/onboarding/migrations/rules');
  if (!g.ok) return g.response;
  if (!orgId) return noOrg();
  try {
    return NextResponse.json(await loadRuleLibrary(supabase, orgId, q.set_id ?? null));
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the mapping rules');
  }
});
