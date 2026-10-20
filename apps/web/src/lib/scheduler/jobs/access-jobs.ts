/**
 * Access & roles scheduled jobs (05-RBAC-SPEC §3.7, wave 2D).
 *
 *   access.expiry_sweep  ends every access assignment whose time box has passed
 *                        (status → expired, logged in core.access_change_log as the
 *                        sweeper) and expires access requests nobody decided within
 *                        14 days. Calls the service-only definer function
 *                        core.expire_access(org) — migration 166.
 *
 * The function is scoped by its p_org argument and only ever touches that tenant's
 * rows, so the service-role client is the right tool here (JobContext.admin: "engines
 * that already scope every read+write to an explicit org").
 *
 * NOT YET: the 7-day / 1-day expiry reminders to grantor and holder (05 §3.7) — they need
 * the notifications sender (IA M-13). The job reports how many grants end within 7 days so
 * the Automation-health widget can show it.
 */

import type { JobContext, JobResult } from '../types';

interface ExpireResult {
  expired_assignments: number;
  failed_assignments: number;
  expired_requests: number;
}

function isExpireResult(v: unknown): v is ExpireResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.expired_assignments === 'number' && typeof o.expired_requests === 'number';
}

export async function runAccessExpirySweepJob(ctx: JobContext): Promise<JobResult> {
  if (!ctx.orgId) return { status: 'skipped', summary: 'This job runs per tenant.' };

  const { data, error } = await ctx.admin.schema('core').rpc('expire_access', { p_org: ctx.orgId });
  if (error) return { status: 'failed', error: error.message };
  if (!isExpireResult(data)) return { status: 'failed', error: 'expire_access returned an unexpected shape.' };

  const weekOut = new Date(ctx.now.getTime() + 7 * 86_400_000).toISOString();
  const { count: endingSoon } = await ctx.admin
    .schema('core')
    .from('access_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', ctx.orgId)
    .eq('status', 'active')
    .not('effective_to', 'is', null)
    .lte('effective_to', weekOut);

  const failed = data.failed_assignments ?? 0;
  const parts = [
    `${data.expired_assignments} grant(s) ended at their time box`,
    `${data.expired_requests} stale request(s) expired`,
  ];
  if ((endingSoon ?? 0) > 0) parts.push(`${endingSoon} more end within 7 days`);
  if (failed > 0) parts.push(`${failed} could not be ended and will be retried`);

  return {
    status: failed > 0 ? 'partial' : 'ok',
    itemsProcessed: data.expired_assignments + data.expired_requests,
    counts: {
      expired_assignments: data.expired_assignments,
      expired_requests: data.expired_requests,
      failed_assignments: failed,
      ending_within_7_days: endingSoon ?? 0,
    },
    summary: `${parts.join('; ')}.`,
  };
}
