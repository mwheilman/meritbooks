export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { ManualRunError, runJobNow } from '@/lib/scheduler/manual';
import { logHumanAction } from '@/lib/trust/action-log';

const schema = z.object({ job_key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_:-]+)+$/) }).strict();

/**
 * POST /api/scheduler/run-now { job_key } — "Run now" on Settings → Automation.
 *
 * AUTHZ: settings_system:edit, for the caller's VERIFIED org only (the job runs for that
 * tenant and no other). Org-scoped, implemented jobs only. The job runs under the same
 * single-flight lock as the cron (never overlaps a scheduled run), with the tenant's
 * RLS-scoped client, and is logged in core.job_runs as trigger 'manual' with the person as
 * actor. Every guard the job has (autonomy dial, period locks, per-period idempotency)
 * applies exactly as on the schedule. Audited to core.action_log.
 */
export const POST = apiHandler(schema, async (body, ctx) => {
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  try {
    const out = await runJobNow({ admin: createAdminSupabase() }, body.job_key, guard.orgId, ctx.userId);
    await logHumanAction(ctx.supabase, ctx.userId, guard.orgId, {
      action: 'scheduler.run_now',
      subjectTable: 'job_runs',
      subjectId: out.runId,
      summary: `Ran ${body.job_key} now: ${out.status}${out.summary ? ` — ${out.summary}` : ''}`.slice(0, 500),
      metadata: { job_key: body.job_key, status: out.status, items: out.itemsProcessed },
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof ManualRunError) return NextResponse.json({ error: e.message, code: 'RUN_REFUSED' }, { status: e.status });
    throw e;
  }
});
