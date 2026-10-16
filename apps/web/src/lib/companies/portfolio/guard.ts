/**
 * Shared auth gate for the portfolio-onboarding routes: an authenticated, org-resolved
 * caller with `settings_acct:edit` — the same permission the onboarding page and
 * Settings → Entities (company creation) require. Fails closed.
 */

import { NextResponse } from 'next/server';
import { requireAuthedContext, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

export type PortfolioContext = ApiContext & { orgId: string };

export async function requirePortfolioContext(): Promise<PortfolioContext | NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const guard = await requirePermission(ctx.userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No resolvable organization', code: 'NO_ORG' }, { status: 400 });
  }
  return { ...ctx, orgId: ctx.orgId };
}
