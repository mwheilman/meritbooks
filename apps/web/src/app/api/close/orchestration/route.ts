export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { resolveActor } from '@/lib/trust/actor';
import { logHumanAction } from '@/lib/trust/action-log';
import { gatherCloseOrchestration, setManualCloseTask } from '@/lib/close/readiness';
import { isManualTaskKey, getCloseTask } from '@/lib/close/orchestration';

/**
 * Close Command Center — orchestration board + manual sign-off.
 *
 * GET  /api/close/orchestration?year&month
 *   Per-entity close task graph: each task's live status (pass/blocked/pending),
 *   the number driving every auto chip, the manual sign-offs, and the hard-close
 *   gate + blockers. READ-ONLY; derived from live ledger state.
 *
 * POST /api/close/orchestration
 *   Toggle a MANUAL task's sign-off for an entity + period (stored in the existing
 *   close_checklists table). Audited to core.action_log.
 *
 * Every query runs through the RLS-scoped client — org isolation is enforced by the
 * database. All money is bigint cents.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const now = new Date();
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') ?? String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get('month') ?? String(now.getMonth() + 1), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid period', code: 'BAD_REQUEST' }, { status: 400 });
  }

  try {
    const board = await gatherCloseOrchestration(supabase, orgId, year, month);
    return NextResponse.json(board);
  } catch (e) {
    console.error('[close/orchestration] failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Failed to load close orchestration', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

const checkoffSchema = z.object({
  location_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  task_key: z.string().min(1),
  is_complete: z.boolean(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = checkoffSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, { status: 422 });
  }
  const body = parsed.data;
  if (!isManualTaskKey(body.task_key)) {
    return NextResponse.json({ error: 'Only manual close tasks can be checked off', code: 'NOT_MANUAL' }, { status: 422 });
  }

  const { coreUserId } = await resolveActor(supabase, userId);
  const ok = await setManualCloseTask(supabase, {
    orgId,
    fiscalPeriodId: body.fiscal_period_id,
    locationId: body.location_id,
    taskKey: body.task_key,
    isComplete: body.is_complete,
    actorCoreUserId: coreUserId,
  });
  if (!ok) return NextResponse.json({ error: 'Failed to record sign-off', code: 'INTERNAL_ERROR' }, { status: 500 });

  const def = getCloseTask(body.task_key);
  await logHumanAction(supabase, userId, orgId, {
    action: 'close.task.signoff',
    subjectTable: 'close_checklists',
    subjectId: body.fiscal_period_id,
    summary: `${body.is_complete ? 'Signed off' : 'Reopened'} "${def.label}"`,
    locationId: body.location_id,
    metadata: { task_key: body.task_key, is_complete: body.is_complete },
  });

  return NextResponse.json({ ok: true });
}
