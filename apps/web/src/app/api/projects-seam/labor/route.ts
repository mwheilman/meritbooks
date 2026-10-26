export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { allocateLaborForRun } from '@/lib/projects-seam/labor-allocation';
import { runLaborAccrual } from '@/lib/projects-seam/labor-accrual';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * POST /api/projects-seam/labor — job labor from payroll (migration 194):
 *   { action: 'allocate', payroll_run_id }            allocate a POSTED payroll run's actual cost to jobs
 *                                                      by approved hours (idempotent per run) — payroll:approve
 *   { action: 'accrue', location_id, as_of }           post the standard-rate accrual for approved hours not
 *                                                      yet paid (trued up when payroll posts) — payroll:approve
 *   { action: 'settings', location_id, accrue_standard_rate } turn the accrual on / off — settings_acct:edit
 * Every write is the service role after the permission + client-scope check, org pinned.
 */
/**
 * Security review LOW: an allocation / accrual failure message is shown when it is a business
 * reason (no department, accounts not set up, run not found); database / driver detail is logged
 * and replaced by a generic sentence.
 */
const DB_DETAIL = /^(payroll lines|labor hours):|violates|relation |column |syntax error|permission denied|duplicate key|invalid input|could not|PGRST|\bsql\b/i;
function publicFailure(msg: string | null | undefined, fallback: string): string {
  return msg && !DB_DETAIL.test(msg) ? msg : fallback;
}

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allocate'), payroll_run_id: z.string().uuid() }),
  z.object({ action: z.literal('accrue'), location_id: z.string().uuid(), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ action: z.literal('settings'), location_id: z.string().uuid(), accrue_standard_rate: z.boolean() }),
]);

export const POST = apiHandler(body, async (b, { userId, orgId, supabase }) => {
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  if (b.action === 'settings') {
    const guard = await requirePermission(userId, 'settings_acct', 'edit', { route: '/api/projects-seam/labor' });
    if (!guard.ok) return guard.response;
    try { await assertWriteScope(supabase, orgId, [b.location_id]); } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
      throw e;
    }
    const w = serviceWriter();
    const { data: existing } = await w.from('job_labor_settings').select('id').eq('org_id', orgId).eq('location_id', b.location_id).maybeSingle();
    const { error } = existing
      ? await w.from('job_labor_settings').update({ accrue_standard_rate: b.accrue_standard_rate, updated_by: userId, updated_at: new Date().toISOString() })
          .eq('org_id', orgId).eq('id', (existing as { id: string }).id)
      : await w.from('job_labor_settings').insert({ org_id: orgId, location_id: b.location_id, accrue_standard_rate: b.accrue_standard_rate, updated_by: userId });
    if (error) {
      console.error('[projects-seam/labor] settings write failed:', error.message);
      return NextResponse.json({ error: 'Could not save the setting. Please try again.' }, { status: 500 });
    }
    await logHumanAction(supabase, userId, orgId, {
      action: 'labor.accrual_setting', subjectTable: 'job_labor_settings', subjectId: b.location_id,
      summary: `Standard-rate job labor accrual ${b.accrue_standard_rate ? 'on' : 'off'}`, locationId: b.location_id,
    });
    return NextResponse.json({ ok: true });
  }

  const guard = await requirePermission(userId, 'payroll', 'approve', { route: '/api/projects-seam/labor' });
  if (!guard.ok) return guard.response;

  if (b.action === 'allocate') {
    // The run must be visible to the caller (RLS + client scope) before the service role posts.
    const { data: run } = await supabase.from('payroll_runs').select('id, location_id').eq('org_id', orgId).eq('id', b.payroll_run_id).maybeSingle();
    if (!run) return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    try { await assertWriteScope(supabase, orgId, [(run as { location_id: string | null }).location_id]); } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
      throw e;
    }
    const r = await allocateLaborForRun(createAdminSupabase(), orgId, b.payroll_run_id);
    if (r.status === 'FAILED') {
      console.error('[projects-seam/labor] allocation failed:', r.error);
      return NextResponse.json({ error: publicFailure(r.error, 'The labor allocation failed — it is recorded on the payroll run and retried by the nightly job.'), result: { status: r.status, allocationId: r.allocationId } }, { status: 422 });
    }
    if (r.status === 'POSTED' && !r.already) {
      await logHumanAction(supabase, userId, orgId, {
        action: 'labor.allocate', subjectTable: 'payroll_runs', subjectId: b.payroll_run_id,
        summary: `Allocated payroll labor to jobs (${r.allocatedCents} cents)`,
      });
    }
    return NextResponse.json({ ok: true, result: r });
  }

  try { await assertWriteScope(supabase, orgId, [b.location_id]); } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  const r = await runLaborAccrual(createAdminSupabase(), orgId, { locationId: b.location_id, asOf: b.as_of, actor: userId });
  if (r.status === 'FAILED') {
    console.error('[projects-seam/labor] accrual failed:', r.error);
    return NextResponse.json({ error: publicFailure(r.error, 'The labor accrual failed. Please try again.'), result: { status: r.status } }, { status: 422 });
  }
  if (r.status === 'POSTED' && !r.already) {
    await logHumanAction(supabase, userId, orgId, {
      action: 'labor.accrue', subjectTable: 'job_labor_accruals', subjectId: r.accrualId,
      summary: `Accrued job labor at standard rate through ${b.as_of}`, locationId: b.location_id,
    });
  }
  return NextResponse.json({ ok: true, result: r });
});
