export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  buildJobHealth,
  runsQuerySchema,
  type JobRunView,
  type ScheduledJobStateView,
} from '@/lib/scheduler/health';

interface LastRunView {
  job_key: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_processed: number;
  summary: string | null;
  error: string | null;
  trigger: string;
}

/**
 * GET /api/scheduler/runs — the tenant's scheduler run log + per-job health, for
 * the "Automation health" widget (IA M-12).
 *
 *   ?job_key=controls.nightly  &status=failed  &limit=50 (≤100)  &before=<ISO started_at cursor>
 *
 * Returns { jobs: (JobHealthView & { lastRun })[], runs: JobRunView[], nextCursor }.
 *
 * AUTHZ: signed-in + settings_system:view, for the caller's VERIFIED org (no
 * first-org fallback). Runs are read through the caller's RLS-scoped client
 * (core.job_runs member_read = own org only) AND filtered by org explicitly.
 * Platform override rows (org_id NULL — invisible to members by RLS) are read with
 * the service role, restricted to job metadata, to compute effective enabled state.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const guard = await requirePermission(ctx.userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;
  const orgId = guard.orgId;

  const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = runsQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const q = parsed.data;

  try {
    let runsQuery = ctx.supabase
      .schema('core')
      .from('job_runs')
      .select('id, job_key, slot_at, attempt, trigger, actor, status, started_at, finished_at, duration_ms, items_processed, counts, summary, error')
      .eq('org_id', orgId)
      .order('started_at', { ascending: false })
      .limit(q.limit + 1);
    if (q.job_key) runsQuery = runsQuery.eq('job_key', q.job_key);
    if (q.status) runsQuery = runsQuery.eq('status', q.status);
    if (q.before) runsQuery = runsQuery.lt('started_at', q.before);

    const statesQuery = createAdminSupabase()
      .schema('core')
      .from('scheduled_jobs')
      .select('job_key, org_id, enabled, cron, last_slot_at, pending_slot_at, attempts, consecutive_failures, backoff_until, lock_owner, lock_expires_at, last_run_at, last_status, next_run_at')
      .is('location_id', null)
      .or(`org_id.eq.${orgId},org_id.is.null`);

    // The newest run per job (for the Automation screen's "last run" column), RLS-scoped.
    const latestQuery = ctx.supabase
      .schema('core')
      .from('job_runs')
      .select('job_key, status, started_at, finished_at, items_processed, summary, error, trigger')
      .eq('org_id', orgId)
      .order('started_at', { ascending: false })
      .limit(400);

    const [runsRes, statesRes, latestRes] = await Promise.all([runsQuery, statesQuery, latestQuery]);
    if (runsRes.error) {
      return NextResponse.json({ error: runsRes.error.message, code: 'DB_ERROR' }, { status: 500 });
    }
    if (statesRes.error) {
      return NextResponse.json({ error: statesRes.error.message, code: 'DB_ERROR' }, { status: 500 });
    }

    const rows = (runsRes.data ?? []) as JobRunView[];
    const hasMore = rows.length > q.limit;
    const runs = hasMore ? rows.slice(0, q.limit) : rows;
    const lastByJob = new Map<string, LastRunView>();
    for (const r of (latestRes.data ?? []) as LastRunView[]) if (!lastByJob.has(r.job_key)) lastByJob.set(r.job_key, r);
    const jobs = buildJobHealth(orgId, (statesRes.data ?? []) as ScheduledJobStateView[]).map((j) => ({
      ...j,
      lastRun: lastByJob.get(j.key) ?? null,
    }));
    return NextResponse.json({
      jobs,
      runs,
      nextCursor: hasMore ? runs[runs.length - 1]?.started_at ?? null : null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
