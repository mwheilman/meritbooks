export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { checkManualJePostSod } from '@/lib/rbac/je-post-sod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  dismissWipRun,
  loadRunLines,
  MIN_DISMISS_REASON,
  postWipRun,
  retryWipReversal,
  WipRunError,
  type WipRunRow,
  type WipSodVerdict,
} from '@/lib/rev-rec/wip-run-service';

/**
 * /api/rev-rec/wip/[runId] — act on one month-end WIP proposal.
 *
 *   GET                                  the job detail saved with the run (drill-down).
 *   POST { action: 'approve' }           post it: billings reclass + WIP adjustment + reversal
 *                                        dated the 1st of next month. Refused (409) if the
 *                                        numbers moved since the proposal — a fresh one is made.
 *   POST { action: 'dismiss', reason }   close this month's review without posting (reason ≥ 4).
 *   POST { action: 'retry_reversal' }    post a reversal that could not post at approval.
 *
 * journal_entries:post for every POST (the human approval — the engine proposed). Uses the
 * authed context directly (a dynamic segment); the body is Zod-validated here.
 *
 * Approve also runs the JE self-post separation of duties (H6_JE_SELF_POST, mode-aware): the
 * member who PROPOSED the run cannot approve it at or above the tenant's self-post amount.
 * The run is claimed PROPOSED → POSTING before anything posts (two approvers → one wins).
 * Approve and dismiss are written to the action log.
 */

/** The largest single entry the run posts (the SoD threshold is per journal entry). */
function largestEntryCents(run: WipRunRow): number {
  return Math.max(Math.abs(Number(run.gross_adjustment_cents ?? 0)), Math.abs(Number(run.reclass_cents ?? 0)));
}

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('dismiss'), reason: z.string().trim().min(MIN_DISMISS_REASON, 'Say why you are not booking this month’s WIP entry').max(500) }),
  z.object({ action: z.literal('retry_reversal') }),
]);

const idSchema = z.string().uuid();

function errorResponse(e: unknown): NextResponse {
  if (e instanceof WipRunError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
  console.error('[rev-rec/wip/run]', e);
  return NextResponse.json({ error: 'Something went wrong', code: 'INTERNAL_ERROR' }, { status: 500 });
}

export async function GET(_request: Request, { params }: { params: { runId: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (!idSchema.safeParse(params.runId).success) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;
  return NextResponse.json({ lines: await loadRunLines(ctx.supabase, ctx.orgId, params.runId) });
}

export async function POST(request: Request, { params }: { params: { runId: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (!idSchema.safeParse(params.runId).success) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });

  const guard = await requirePermission(ctx.userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const body = parsed.data;

  try {
    const orgId = ctx.orgId;
    if (body.action === 'approve') {
      const sod = async (run: WipRunRow): Promise<WipSodVerdict> => {
        const v = await checkManualJePostSod(createAdminSupabase(), {
          orgId,
          actor: ctx.userId,
          // A scheduler-made proposal has no human preparer; a member's proposal does.
          preparedBy: run.requested_by ?? null,
          amountCents: largestEntryCents(run),
          route: '/api/rev-rec/wip/[runId]',
          locationId: run.location_id,
        });
        return v.ok ? { ok: true } : { ok: false, status: v.status, error: v.error, code: v.code };
      };
      const res = await postWipRun(ctx.supabase, orgId, { runId: params.runId, approvedBy: ctx.userId, sod });
      const numbers = Object.values(res.entryNumbers).filter(Boolean).join(', ');
      await logHumanAction(createAdminSupabase(), ctx.userId, orgId, {
        action: 'revrec.wip.approve',
        subjectTable: 'rev_rec_wip_runs',
        subjectId: res.run.id,
        summary: `Approved & posted WIP ${res.run.period_key}${numbers ? `: ${numbers}` : ''}${res.reversalPending ? ' (reversal pending)' : ''}`,
        locationId: res.run.location_id,
      });
      return NextResponse.json({ ok: true, ...res });
    }
    if (body.action === 'dismiss') {
      const run = await dismissWipRun(ctx.supabase, orgId, { runId: params.runId, reason: body.reason, dismissedBy: ctx.userId });
      await logHumanAction(createAdminSupabase(), ctx.userId, orgId, {
        action: 'revrec.wip.dismiss',
        subjectTable: 'rev_rec_wip_runs',
        subjectId: run.id,
        summary: `Dismissed WIP proposal ${run.period_key}: ${body.reason}`.slice(0, 500),
        locationId: run.location_id,
      });
      return NextResponse.json({ ok: true, run });
    }
    const run = await retryWipReversal(ctx.supabase, ctx.orgId, { runId: params.runId });
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    return errorResponse(e);
  }
}
