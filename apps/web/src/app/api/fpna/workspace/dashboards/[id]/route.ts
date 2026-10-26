export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { archivePersonal } from '@/lib/fpna/workspace/server/dashboards-store';
import { noOrg, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';

/** DELETE /api/fpna/workspace/dashboards/[id] — archive one of the reader's own dashboards. reports:view. */
export async function DELETE(_req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return noOrg();
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Invalid id', code: 'VALIDATION_ERROR' }, { status: 422 });
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/dashboards/[id]' });
  if (!guard.ok) return guard.response;
  try {
    await archivePersonal({ supabase: ctx.supabase, orgId: ctx.orgId }, ctx.userId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/dashboards/[id]');
  }
}
