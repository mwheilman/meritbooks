export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { publishSchema } from '@/lib/fpna/workspace/dashboard-model';
import { publishDefault, withdrawDefault } from '@/lib/fpna/workspace/server/dashboards-store';
import { noOrg, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';

/**
 * POST /api/fpna/workspace/dashboards/publish — publish a role default (IA M-8): cards, period
 * basis, lock level (unlocked · add_move · locked), required metrics, publish mode
 * (new_users · override). A new VERSION each time; the prior version stops being current.
 * Administrators only: settings_acct:edit (403 otherwise). Body `{ withdraw: id }` withdraws one.
 */
const bodySchema = z.union([publishSchema, z.object({ withdraw: z.string().uuid() })]);

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'settings_acct', 'edit', { route: '/api/fpna/workspace/dashboards/publish' });
  if (!guard.ok) return guard.response;
  try {
    const store = { supabase: ctx.supabase, orgId: ctx.orgId };
    if ('withdraw' in body) {
      await withdrawDefault(store, body.withdraw);
      return NextResponse.json({ ok: true });
    }
    const row = await publishDefault(store, ctx.userId, body);
    return NextResponse.json({ dashboard: row }, { status: 201 });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/dashboards/publish');
  }
});
