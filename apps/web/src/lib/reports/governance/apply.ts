/**
 * applyGovernance(view, ctx) — THE server-side enforcement entry point for every report and
 * metric API (Wave 3A engine, 3B metrics). FPB-tenant-model-consolidation-analytics §18.3.
 *
 *   const decision = await applyGovernance(
 *     { periods: ['2026-07', '2026-08', '2026-09'], locationIds, scopeKind: 'consolidated' },
 *     { supabase, orgId, userId, includePreview: q.preview !== '0', proForma: q.pro_forma === '1' },
 *   );
 *   const rows = filterByGovernance(balances, decision, (b) => ({ periodKey: b.period, locationId: b.location_id }));
 *   return NextResponse.json({ rows, governance: decision });
 *
 * - The AUDIENCE is resolved here from the caller's capabilities (never from input).
 *   `includePreview` / `proForma` are honoured for finance only.
 * - Facts are read with the caller's RLS client: a company outside the caller's org or
 *   client scope is `out_of_scope` and never contributes.
 * - The figures themselves are never read here; callers drop what the decision hides.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateGovernance } from './policy';
import { loadGovernanceFacts } from './load';
import { permissionProbe, resolveGovernanceAudience, ResolvedAudience, type CapabilityProbe } from './audience';
import { isPeriodKey } from './periods';
import { DEFAULT_RELEASE_SETTINGS, type GovernanceDecision, type GovernanceFacts, type GovernanceView } from './types';

export interface GovernanceRequestContext {
  /** The caller's RLS-scoped client (ApiContext.supabase). */
  supabase: SupabaseClient;
  orgId: string;
  /** Clerk user id (for the capability probe). */
  userId: string;
  includePreview?: boolean;
  proForma?: boolean;
  /** Clock override (tests); defaults to now. */
  now?: Date;
  /** Reuse an audience already resolved in this request (saves two permission reads). */
  audience?: ResolvedAudience;
  deps?: {
    probe?: CapabilityProbe;
    loadFacts?: (supabase: SupabaseClient, orgId: string, locationIds: readonly string[]) => Promise<GovernanceFacts>;
  };
}

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function applyGovernance(view: GovernanceView, ctx: GovernanceRequestContext): Promise<GovernanceDecision> {
  if (!ctx.orgId) throw new Error('applyGovernance: no organization');
  const bad = view.periods.filter((k) => !isPeriodKey(k));
  if (bad.length) throw new Error(`applyGovernance: invalid period key(s) ${bad.join(', ')}`);

  const audience =
    ctx.audience instanceof ResolvedAudience
      ? ctx.audience
      : await resolveGovernanceAudience(ctx.deps?.probe ?? permissionProbe(ctx.userId));
  const load = ctx.deps?.loadFacts ?? loadGovernanceFacts;
  // An empty request stays empty — never "every company".
  const facts: GovernanceFacts = view.locationIds.length
    ? await load(ctx.supabase, ctx.orgId, view.locationIds)
    : { companies: {}, tenantSettings: DEFAULT_RELEASE_SETTINGS };

  return evaluateGovernance({
    view,
    facts,
    audience: audience.audience,
    options: { includePreview: ctx.includePreview, proForma: ctx.proForma },
    today: todayISO(ctx.now),
  });
}

export { ResolvedAudience };
export { resolveGovernanceAudience, permissionProbe } from './audience';
export { filterByGovernance, assertShown, isShown, GovernanceDeniedError } from './filter';
export type * from './types';
