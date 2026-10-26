export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { packList, personalSaveSchema, resolveEffectiveDashboard } from '@/lib/fpna/workspace/dashboard-model';
import { listDashboards, savePersonal } from '@/lib/fpna/workspace/server/dashboards-store';
import { noOrg, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';
import type { DashboardListResponse } from '@/lib/fpna/workspace/types';

/**
 * GET  /api/fpna/workspace/dashboards — the reader's effective dashboard (personal → role
 *      default → every-role default → pack), their personal dashboards, the published role
 *      defaults (with lock level) and the built-in packs. reports:view.
 * POST /api/fpna/workspace/dashboards — save (create / update) a personal dashboard. The lock
 *      level of the role default is enforced (409 DASHBOARD_LOCKED / REQUIRED_METRIC_REMOVED);
 *      the write is the service role (migration 191: members hold no write grant).
 */
const listSchema = z.object({ dashboard: z.string().max(64).optional() });

export const GET = apiQueryHandler(listSchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/dashboards' });
  if (!guard.ok) return guard.response;
  try {
    const store = { supabase: ctx.supabase, orgId: ctx.orgId };
    const lists = await listDashboards(store, ctx.userId);
    const publish = await requirePermission(ctx.userId, 'settings_acct', 'edit', { route: '/api/fpna/workspace/dashboards' });
    const body: DashboardListResponse & { available: boolean } = {
      effective: resolveEffectiveDashboard({ role: guard.role, personal: lists.personal, tenant: lists.tenant, requested: q.dashboard ?? null }),
      personal: lists.personal.map((p) => ({ id: p.id, name: p.name, packKey: p.packKey, updatedAt: p.updatedAt, cardCount: p.cards.length })),
      tenant: lists.tenant.map((t) => ({ id: t.id, roleKey: t.roleKey, name: t.name, version: t.version, lockLevel: t.lockLevel, publishMode: t.publishMode, publishedBy: t.publishedBy, publishedAt: t.publishedAt, cardCount: t.cards.length })),
      packs: packList(),
      role: guard.role,
      canPublish: publish.ok && lists.available,
      available: lists.available,
    };
    return NextResponse.json(body);
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/dashboards');
  }
});

export const POST = apiHandler(personalSaveSchema, async (input, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/dashboards' });
  if (!guard.ok) return guard.response;
  try {
    const row = await savePersonal({ supabase: ctx.supabase, orgId: ctx.orgId }, ctx.userId, guard.role, input);
    return NextResponse.json({ dashboard: row }, { status: input.id ? 200 : 201 });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/dashboards');
  }
});
