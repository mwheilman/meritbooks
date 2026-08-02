export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { approveRun, rejectRun } from '@/lib/recurring-je/store';
import { approveSchema, type ApproveBody } from '@/lib/recurring-je/schema';

/**
 * POST /api/recurring-journal-entries/approve — approve a PROPOSED recurring entry
 * (post it to the GL through the deterministic engine) or reject/skip it. Gated on
 * `journal_entries:post` — this WRITES a balanced journal entry. The run's
 * PROPOSED→POSTED transition plus the `(template, period)` unique index guarantee a
 * period is posted at most once; a re-approve is a no-op.
 */
export const POST = apiHandler(
  approveSchema,
  async (body: ApproveBody, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    if (body.action === 'reject') {
      const guard = await requirePermission(ctx.userId, 'journal_entries', 'create');
      if (!guard.ok) return guard.response;
      const res = await rejectRun(ctx.supabase, body.run_id);
      if (!res.success) return NextResponse.json({ error: res.error, code: 'REJECT_FAILED' }, { status: 400 });
      return NextResponse.json({ success: true, action: 'reject' });
    }

    const guard = await requirePermission(ctx.userId, 'journal_entries', 'post');
    if (!guard.ok) return guard.response;

    const res = await approveRun(ctx.supabase, ctx.orgId, body.run_id);
    if (!res.success) return NextResponse.json({ error: res.error, code: 'APPROVE_FAILED' }, { status: 400 });
    return NextResponse.json({ success: true, entry_id: res.entry_id, entry_number: res.entry_number });
  },
);
