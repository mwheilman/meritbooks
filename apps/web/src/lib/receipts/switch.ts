/**
 * The receipt-chase on/off switch, per tenant and per client (FPB-workforce-app §4.9).
 *
 *   tenant  core.organizations.receipt_chase_enabled (default on)
 *   client  public.company_policies.receipt_chase_enabled (null = follow the tenant)
 *
 * Off → live receipt requests in scope are cancelled with the pause reason and their
 * charges show "Chase off"; nothing is deleted. On → `_changed_at` is stamped; the next
 * sync re-asks only charges still inside the chase window, one request each (no burst).
 * A client cannot be switched ON while the tenant is off. Every change is audited
 * (audit_log: old → new, plus the typed reason). Service role; the route authorized.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { pauseChase } from './chase';

export class SwitchError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'SwitchError';
  }
}

export type SwitchScope = { kind: 'tenant' } | { kind: 'client'; locationId: string; follow?: boolean };

export interface SwitchResult {
  scope: 'tenant' | 'client';
  enabled: boolean | null;
  previous: boolean | null;
  paused: number;
}

async function audit(
  db: SupabaseClient,
  orgId: string,
  table: string,
  recordId: string,
  oldValue: string,
  newValue: string,
  reason: string,
  actor: string,
): Promise<void> {
  const rows = [
    { org_id: orgId, table_name: table, record_id: recordId, action: 'UPDATE', field_name: 'receipt_chase_enabled', old_value: oldValue, new_value: newValue, user_id: actor },
    { org_id: orgId, table_name: table, record_id: recordId, action: 'UPDATE', field_name: 'receipt_chase_reason', old_value: null, new_value: reason.slice(0, 500), user_id: actor },
  ];
  const { error } = await serviceWriter(db).from('audit_log').insert(rows);
  if (error) throw new SwitchError(`Could not audit the change, so nothing was changed: ${error.message}`, 500);
}

const show = (v: boolean | null) => (v === null ? 'follow tenant' : v ? 'on' : 'off');

export async function setReceiptChase(
  db: SupabaseClient,
  orgId: string,
  scope: SwitchScope,
  enabled: boolean,
  reason: string,
  actor: string,
  now: Date,
): Promise<SwitchResult> {
  const why = reason.trim();
  if (why.length < 3) throw new SwitchError('Say why (it goes on the audit trail).');
  const iso = now.toISOString();

  const { data: org, error: orgErr } = await db.schema('core').from('organizations').select('id, receipt_chase_enabled').eq('id', orgId).maybeSingle();
  if (orgErr || !org) throw new SwitchError('Organization not found.', 404);
  const tenantOn = (org as { receipt_chase_enabled: boolean | null }).receipt_chase_enabled !== false;

  if (scope.kind === 'tenant') {
    if (tenantOn === enabled) return { scope: 'tenant', enabled, previous: tenantOn, paused: 0 };
    await audit(db, orgId, 'organizations', orgId, show(tenantOn), show(enabled), why, actor);
    const { error } = await db
      .schema('core')
      .from('organizations')
      .update({ receipt_chase_enabled: enabled, receipt_chase_changed_at: iso, receipt_chase_changed_by: actor })
      .eq('id', orgId);
    if (error) throw new SwitchError(`Could not change the switch: ${error.message}`, 500);
    const paused = enabled ? 0 : await pauseChase(db, orgId, {}, 'chase_off', actor, now);
    return { scope: 'tenant', enabled, previous: tenantOn, paused };
  }

  // client
  const { data: loc } = await db.schema('core').from('locations').select('id').eq('org_id', orgId).eq('id', scope.locationId).maybeSingle();
  if (!loc) throw new SwitchError('That company is not part of this organization.', 404);
  const next: boolean | null = scope.follow ? null : enabled;
  if (next === true && !tenantOn) throw new SwitchError('Receipt chase is off for the whole organization. Turn it on there first.', 409);

  const { data: cp } = await serviceWriter(db).from('company_policies').select('id, receipt_chase_enabled').eq('org_id', orgId).eq('location_id', scope.locationId).maybeSingle();
  const row = cp as { id: string; receipt_chase_enabled: boolean | null } | null;
  const prev = row?.receipt_chase_enabled ?? null;
  if (row && prev === next) return { scope: 'client', enabled: next, previous: prev, paused: 0 };
  await audit(db, orgId, 'company_policies', row?.id ?? scope.locationId, show(prev), show(next), why, actor);
  const patch = { receipt_chase_enabled: next, receipt_chase_changed_at: iso, receipt_chase_changed_by: actor, updated_at: iso };
  const { error } = row
    ? await serviceWriter(db).from('company_policies').update(patch).eq('org_id', orgId).eq('id', row.id)
    : await serviceWriter(db).from('company_policies').insert({ org_id: orgId, location_id: scope.locationId, ...patch });
  if (error) throw new SwitchError(`Could not change the switch: ${error.message}`, 500);
  const effectiveOff = !tenantOn || next === false;
  const paused = effectiveOff ? await pauseChase(db, orgId, { locationId: scope.locationId }, 'chase_off', actor, now) : 0;
  return { scope: 'client', enabled: next, previous: prev, paused };
}
