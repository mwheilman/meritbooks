export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { emailConfigStatus } from '@/lib/email/provider';
import { describeCadence, isValidTimeZone, quietHoursOf } from '@/lib/requests/cadence';
import { allPolicies, DEFAULT_QUIET, loadPolicyContext, POLICY_DEFAULTS } from '@/lib/requests/policy';
import { REQUESTS_SETTINGS, REQUESTS_VIEW, requireAny } from '@/lib/requests/route-auth';
import { policiesPutBody } from '@/lib/validations/requests';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * /api/requests/policies — tenant cadence defaults (Requests → Settings card).
 *
 * GET  every policy as it resolves today (code default ← tenant row), plus the tenant
 *      quiet hours / time zone. Receipt chase is shown read-only: it comes from
 *      Settings → Receipt chase (core.organizations.chase_*).
 * PUT  settings_system:edit. Writes core.request_policies through the service role,
 *      org pinned (member-SELECT-only table, migration 178). Null = inherit the default.
 */

export const GET = apiQueryHandler(null, async (_q, { userId, orgId }) => {
  const guard = await requireAny(userId, REQUESTS_VIEW, '/api/requests/policies');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Policies are tenant configuration (no client rows); the service read is org pinned.
  const ctx = await loadPolicyContext(serviceWriter(), orgId);
  const tenantDefault = ctx.rows.find((r) => r.policy_key === 'default' && r.location_id == null) ?? null;
  const canEdit = (await requireAny(userId, REQUESTS_SETTINGS, '/api/requests/policies')).ok;
  return NextResponse.json({
    canEdit,
    email: emailConfigStatus(),
    tenant: {
      quiet: quietHoursOf(tenantDefault?.quiet_start, tenantDefault?.quiet_end) ?? DEFAULT_QUIET,
      timezone: tenantDefault?.timezone ?? ctx.org.timezone ?? 'UTC',
      orgTimezone: ctx.org.timezone,
    },
    policies: allPolicies(ctx).map((p) => ({
      key: p.key,
      label: p.label,
      anchor: p.anchor,
      offsetsMinutes: p.cadence.offsetsMinutes,
      repeatEveryMinutes: p.cadence.repeatEveryMinutes,
      maxSends: p.cadence.maxSends,
      escalateAfter: p.escalateAfter,
      channels: p.channels,
      autoCreate: p.autoCreate,
      source: p.source,
      cadenceText: describeCadence(p.cadence, p.anchor),
      supportsAutoCreate: p.key === 'w9' || p.key === 'coi' || p.key === 'coi_renewal',
      quiet: p.quiet,
    })),
  });
});

export const PUT = apiHandler(policiesPutBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requireAny(userId, REQUESTS_SETTINGS, '/api/requests/policies');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  for (const p of b.policies) {
    if ((p.quiet_start == null) !== (p.quiet_end == null)) {
      return NextResponse.json({ error: 'Quiet hours need both a start and an end.', code: 'VALIDATION_ERROR' }, { status: 422 });
    }
    if (p.timezone && !isValidTimeZone(p.timezone)) {
      return NextResponse.json({ error: `"${p.timezone}" is not a time zone we recognise (use e.g. America/Chicago).`, code: 'VALIDATION_ERROR' }, { status: 422 });
    }
    if (p.policy_key !== 'default' && p.cadence_offsets_minutes) {
      const anchor = p.policy_key in POLICY_DEFAULTS ? POLICY_DEFAULTS[p.policy_key as keyof typeof POLICY_DEFAULTS].anchor : 'created';
      if (anchor === 'created' && p.cadence_offsets_minutes.some((m) => m < 0)) {
        return NextResponse.json({ error: 'Days after the ask can’t be negative.', code: 'VALIDATION_ERROR' }, { status: 422 });
      }
    }
  }

  const writer = serviceWriter();
  const now = new Date().toISOString();
  for (const p of b.policies) {
    const values: Record<string, unknown> = { updated_by: userId, updated_at: now };
    for (const k of ['auto_create', 'cadence_offsets_minutes', 'repeat_every_minutes', 'max_sends', 'escalate_after', 'quiet_start', 'quiet_end', 'timezone'] as const) {
      if (p[k] !== undefined) values[k] = p[k];
    }
    if (Array.isArray(values.cadence_offsets_minutes)) values.cadence_offsets_minutes = [...(values.cadence_offsets_minutes as number[])].sort((x, y) => x - y);
    const { data: existing } = await writer
      .schema('core')
      .from('request_policies')
      .select('id')
      .eq('org_id', orgId)
      .eq('policy_key', p.policy_key)
      .is('location_id', null)
      .maybeSingle();
    const { error } = existing
      ? await writer.schema('core').from('request_policies').update(values).eq('id', (existing as { id: string }).id).eq('org_id', orgId)
      : await writer.schema('core').from('request_policies').insert({ ...values, org_id: orgId, policy_key: p.policy_key, location_id: null });
    if (error) return NextResponse.json({ error: error.message, code: 'WRITE_FAILED' }, { status: 500 });
  }
  await logHumanAction(supabase, userId, orgId, {
    action: 'requests.policies.update',
    subjectTable: 'core.request_policies',
    summary: `Request cadence settings changed: ${b.policies.map((p) => p.policy_key).join(', ')}`,
    metadata: { policies: b.policies },
  });
  return NextResponse.json({ ok: true });
});
