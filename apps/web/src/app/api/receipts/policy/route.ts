export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertOrgRefs, assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  RECEIPT_POLICY_COLUMNS,
  chaseEnabledFor,
  loadReceiptPolicyContext,
  mergeReceiptPolicy,
  policyPatchToRow,
  validatePolicyPatch,
  type ReceiptPolicy,
} from '@/lib/receipts/policy';
import { receiptPolicyBody } from '@/lib/validations/receipts';

const getQuery = z.object({ location_id: z.string().uuid().optional() });

/**
 * GET /api/receipts/policy — the receipt policy (tenant, and the client's overrides when
 * `location_id` is given), the chase switches and the Settings → Receipt chase values
 * the cadence uses. receipts:view.
 * PUT — save tenant or client policy (settings_acct:edit, the same control tier as
 * Settings → Receipt chase). Client values left empty inherit the tenant.
 */
export const GET = apiQueryHandler(getQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/policy' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const ctx = await loadReceiptPolicyContext(supabase, orgId);
  const { data: org } = await supabase
    .schema('core')
    .from('organizations')
    .select('chase_quiet_start, chase_quiet_end, timezone, receipt_chase_changed_by')
    .eq('id', orgId)
    .maybeSingle();
  const o = (org ?? {}) as { chase_quiet_start?: string | null; chase_quiet_end?: string | null; timezone?: string | null; receipt_chase_changed_by?: string | null };
  const loc = q.location_id ?? null;
  const client = loc ? ctx.switches.clients.get(loc) : undefined;
  return NextResponse.json({
    tenant: mergeReceiptPolicy(ctx.rows, null),
    client: loc ? mergeReceiptPolicy(ctx.rows, loc) : null,
    clientOverrides: loc ? ctx.rows.find((r) => r.location_id === loc) ?? null : null,
    switches: {
      tenantEnabled: ctx.switches.tenantEnabled,
      tenantChangedAt: ctx.switches.tenantChangedAt,
      tenantChangedBy: o.receipt_chase_changed_by ?? null,
      clientSetting: loc ? client?.enabled ?? null : null,
      clientChangedAt: loc ? client?.changedAt ?? null : null,
      effective: loc ? chaseEnabledFor(ctx.switches, loc) : ctx.switches.tenantEnabled,
    },
    cadence: {
      firstReminderMinutes: ctx.firstReminderMinutes,
      channel: ctx.chaseChannel,
      quietStart: o.chase_quiet_start ? String(o.chase_quiet_start).slice(0, 5) : null,
      quietEnd: o.chase_quiet_end ? String(o.chase_quiet_end).slice(0, 5) : null,
      timezone: o.timezone ?? ctx.orgTimezone,
    },
  });
});

export const PUT = apiHandler(receiptPolicyBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'settings_acct', 'edit', { route: '/api/receipts/policy' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const patch = b.patch ?? {};

  try {
    if (b.location_id) await assertWriteScope(supabase, orgId, [b.location_id]);
    if (patch.bookkeeperMembershipId) {
      await assertOrgRefs(orgId, [{ schema: 'core', table: 'memberships', ids: [patch.bookkeeperMembershipId], label: 'bookkeeper' }], { caller: supabase });
    }
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const db = serviceWriter();
  const ctx = await loadReceiptPolicyContext(db, orgId);
  // Validate the RESULT (tenant ← client), not just the patch, so a client can't make suggest > auto.
  const current = mergeReceiptPolicy(ctx.rows, b.location_id);
  const resulting: Partial<ReceiptPolicy> = { ...current };
  for (const [k, v] of Object.entries(patch) as Array<[keyof ReceiptPolicy, unknown]>) {
    if (v !== null && v !== undefined) (resulting as Record<string, unknown>)[k] = v;
  }
  const err = validatePolicyPatch(resulting);
  if (err) return NextResponse.json({ error: err }, { status: 422 });

  const now = new Date().toISOString();
  const existing = ctx.rows.find((r) => (b.location_id ? r.location_id === b.location_id : r.location_id == null)) ?? null;
  if (b.reset && b.location_id) {
    if (existing?.id) await db.from('receipt_policies').delete().eq('org_id', orgId).eq('id', existing.id);
    return NextResponse.json({ ok: true, message: 'This company follows the organization’s receipt policy again.' });
  }
  const row = { ...policyPatchToRow(patch as Partial<ReceiptPolicy>), updated_by: userId, updated_at: now };
  const { error } = existing?.id
    ? await db.from('receipt_policies').update(row).eq('org_id', orgId).eq('id', existing.id)
    : await db.from('receipt_policies').insert({ org_id: orgId, location_id: b.location_id, ...row });
  if (error) return NextResponse.json({ error: `Could not save the policy: ${error.message}` }, { status: 500 });
  const { data: saved } = await db.from('receipt_policies').select(RECEIPT_POLICY_COLUMNS).eq('org_id', orgId);
  return NextResponse.json({ ok: true, message: 'Receipt policy saved.', policy: mergeReceiptPolicy((saved ?? []) as typeof ctx.rows, b.location_id) });
});
