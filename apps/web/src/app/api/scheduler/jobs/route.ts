export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getJob } from '@/lib/scheduler/registry';
import { ManualRunError, setTenantJobEnabled } from '@/lib/scheduler/manual';
import { logHumanAction } from '@/lib/trust/action-log';

const schema = z
  .object({
    job_key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_:-]+)+$/),
    /** true / false = override for this tenant; null = back to the default. */
    enabled: z.boolean().nullable(),
  })
  .strict();

/**
 * PUT /api/scheduler/jobs { job_key, enabled } — switch one scheduled job on or off for
 * the caller's tenant (Settings → Automation). Writes the tenant row's override in
 * core.scheduled_jobs (service role, org pinned); a platform kill switch
 * (SCHEDULER_PAUSED / SCHEDULER_DISABLED_JOBS / the platform row) still wins.
 *
 * AUTHZ: settings_system:edit for the VERIFIED org. Org-scoped, implemented jobs only.
 * Audited to core.action_log.
 */
export const PUT = apiHandler(schema, async (body, ctx) => {
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  try {
    await setTenantJobEnabled(createAdminSupabase(), body.job_key, guard.orgId, body.enabled);
  } catch (e) {
    if (e instanceof ManualRunError) return NextResponse.json({ error: e.message, code: 'TOGGLE_REFUSED' }, { status: e.status });
    throw e;
  }
  const label = getJob(body.job_key)?.label ?? body.job_key;
  await logHumanAction(ctx.supabase, ctx.userId, guard.orgId, {
    action: 'scheduler.job_toggle',
    subjectTable: 'scheduled_jobs',
    summary: `${body.enabled === null ? 'Reset' : body.enabled ? 'Turned on' : 'Turned off'} the scheduled job "${label}"`,
    metadata: { job_key: body.job_key, enabled: body.enabled },
  });
  return NextResponse.json({ ok: true, job_key: body.job_key, enabled: body.enabled });
});
