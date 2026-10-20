/**
 * Per-client enablement, policies, role map and department map (FPB §9.3).
 *
 * Enabling is gated twice: here (readable reasons for the UI) and by the DB trigger
 * trg_dealer_pack_enable_gate (mig 169), which refuses enabled=true while any required
 * role / department role is unmapped. The opening tie-out (§4.3: open notes = floor plan
 * payable, carried unit cost = unit inventory, …) must be zero difference to enable.
 */

import { audit } from './audit';
import { evaluateTieout, type TieoutRow } from '../engine/summary';
import { ROLE_SPEC, NEW_DEALER_ROLES, type DealerRole } from '../roles';
import { DEPT_ROLES, defaultSettings, type DealerSettings, type DeptRole } from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';
import { loadRoleMap } from './posting';

type Ctx = Pick<DealerCtx, 'orgId' | 'locationId'> & { db: DealerCtx['db'] };

function coerce(row: Record<string, unknown>): DealerSettings {
  const num = (k: string) => Number(row[k]);
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    location_id: row.location_id as string,
    enabled: row.enabled === true,
    dms_system: (row.dms_system as string | null) ?? null,
    trade_valuation_policy: row.trade_valuation_policy as DealerSettings['trade_valuation_policy'],
    warranty_recognition: row.warranty_recognition as DealerSettings['warranty_recognition'],
    warranty_relieve_parts_inventory: row.warranty_relieve_parts_inventory !== false,
    capitalize_setup_labor: row.capitalize_setup_labor !== false,
    cost_reduction_in_stock: row.cost_reduction_in_stock as DealerSettings['cost_reduction_in_stock'],
    oem_settlement_default: row.oem_settlement_default as DealerSettings['oem_settlement_default'],
    sot_grace_days: num('sot_grace_days'),
    aging_buckets: ((row.aging_buckets as number[] | null) ?? [90, 180, 270, 365]).map(Number),
    term_warning_days: num('term_warning_days'),
    interest_tolerance_cents: num('interest_tolerance_cents'),
    interest_tolerance_bps: num('interest_tolerance_bps'),
    statement_tolerance_cents: num('statement_tolerance_cents'),
    auto_match_min_confidence_bps: num('auto_match_min_confidence_bps'),
    curtailment_warn_days: num('curtailment_warn_days'),
    warranty_deadline_warn_days: num('warranty_deadline_warn_days'),
    warranty_submitted_aging_days: num('warranty_submitted_aging_days'),
    incentive_deadline_warn_days: num('incentive_deadline_warn_days'),
    incentive_submitted_aging_days: num('incentive_submitted_aging_days'),
    lien_unpaid_days: num('lien_unpaid_days'),
    over_allowance_warn_bps: num('over_allowance_warn_bps'),
    line_utilization_warn_bps: num('line_utilization_warn_bps'),
    trade_acv_approval_threshold_cents: num('trade_acv_approval_threshold_cents'),
  };
}

export async function loadSettings(c: Ctx): Promise<DealerSettings> {
  const { data, error } = await c.db
    .from('dealer_pack_settings')
    .select('*')
    .eq('org_id', c.orgId)
    .eq('location_id', c.locationId)
    .maybeSingle();
  if (error) dbFail('Settings lookup failed', error);
  return data ? coerce(data as Record<string, unknown>) : defaultSettings(c.orgId, c.locationId);
}

/** Money events require the pack to be on for the client. */
export async function requireEnabled(d: DealerCtx): Promise<DealerSettings> {
  const s = await loadSettings(d);
  if (!s.enabled) throw new DealerError('NOT_ENABLED', 'The dealer pack is not enabled for this client.');
  return s;
}

export type SettingsPatch = Partial<Omit<DealerSettings, 'id' | 'org_id' | 'location_id' | 'enabled'>>;

export async function saveSettings(d: DealerCtx, patch: SettingsPatch): Promise<DealerSettings> {
  const { error } = await d.admin
    .from('dealer_pack_settings')
    .upsert(
      { ...patch, org_id: d.orgId, location_id: d.locationId, updated_by: d.userId },
      { onConflict: 'org_id,location_id' },
    );
  if (error) dbFail('Saving dealer settings failed', error);
  return loadSettings({ ...d, db: d.admin });
}

export interface RoleMappingInput {
  roleKey: DealerRole;
  /** null = remove this client's explicit mapping (fallbacks then apply). */
  accountId: string | null;
}

export async function mapRoles(d: DealerCtx, mappings: RoleMappingInput[]): Promise<void> {
  const ids = mappings.map((m) => m.accountId).filter((x): x is string => !!x);
  const { data: accts, error } = ids.length
    ? await d.admin
        .from('accounts')
        .select('id, account_type, account_number, is_active, is_company_specific, company_location_id')
        .eq('org_id', d.orgId)
        .in('id', ids)
    : { data: [], error: null };
  if (error) dbFail('Account lookup failed', error);
  const byId = new Map(
    ((accts ?? []) as { id: string; account_type: string; account_number: string; is_active: boolean; company_location_id: string | null }[]).map((a) => [a.id, a]),
  );
  for (const m of mappings) {
    const spec = ROLE_SPEC[m.roleKey];
    if (!spec) throw new DealerError('VALIDATION', `Unknown role ${m.roleKey}`);
    if (!m.accountId) {
      const { error: delErr } = await d.admin
        .from('account_roles')
        .delete()
        .eq('org_id', d.orgId)
        .eq('role_key', m.roleKey)
        .eq('location_id', d.locationId);
      if (delErr) dbFail('Removing role mapping failed', delErr);
      continue;
    }
    const a = byId.get(m.accountId);
    if (!a) throw new DealerError('VALIDATION', `Account for ${spec.label} is not in this organization`);
    if (!a.is_active) throw new DealerError('VALIDATION', `Account ${a.account_number} is inactive`);
    if (a.company_location_id && a.company_location_id !== d.locationId) {
      throw new DealerError('VALIDATION', `Account ${a.account_number} belongs to another client`);
    }
    if (!spec.allowedTypes.includes(a.account_type as never)) {
      throw new DealerError('VALIDATION', `${spec.label} must map to ${spec.allowedTypes.join(' or ')} (got ${a.account_type})`);
    }
    const { data: existing, error: exErr } = await d.admin
      .from('account_roles')
      .select('id')
      .eq('org_id', d.orgId)
      .eq('role_key', m.roleKey)
      .eq('location_id', d.locationId)
      .maybeSingle();
    if (exErr) dbFail('Role mapping lookup failed', exErr);
    const write = existing
      ? d.admin.from('account_roles').update({ account_id: m.accountId }).eq('id', (existing as { id: string }).id)
      : d.admin.from('account_roles').insert({ org_id: d.orgId, role_key: m.roleKey, account_id: m.accountId, location_id: d.locationId });
    const { error: wErr } = await write;
    if (wErr) dbFail('Saving role mapping failed', wErr);
  }
}

export async function mapDepartments(d: DealerCtx, mappings: { deptRole: DeptRole; departmentId: string | null }[]): Promise<void> {
  for (const m of mappings) {
    if (!DEPT_ROLES.includes(m.deptRole)) throw new DealerError('VALIDATION', `Unknown department role ${m.deptRole}`);
    if (!m.departmentId) {
      const { error } = await d.admin
        .from('dealer_department_map')
        .delete()
        .eq('org_id', d.orgId)
        .eq('location_id', d.locationId)
        .eq('dept_role', m.deptRole);
      if (error) dbFail('Removing department mapping failed', error);
      continue;
    }
    // The same-tenant trigger re-checks org + client ownership of the department.
    const { error } = await d.admin
      .from('dealer_department_map')
      .upsert(
        { org_id: d.orgId, location_id: d.locationId, dept_role: m.deptRole, department_id: m.departmentId },
        { onConflict: 'org_id,location_id,dept_role' },
      );
    if (error) {
      if (/not in this organization/i.test(error.message)) throw new DealerError('VALIDATION', error.message);
      dbFail('Saving department mapping failed', error);
    }
  }
}

export interface Readiness {
  enabled: boolean;
  missing: string[];
  roles: { roleKey: string; label: string; required: boolean; accountId: string | null; mappedDirectly: boolean; isNew: boolean }[];
  departments: { deptRole: DeptRole; departmentId: string | null }[];
  tieout: { ok: boolean; problems: string[]; rows: TieoutRow[] };
  canEnable: boolean;
}

export async function loadTieout(c: Pick<DealerCtx, 'orgId' | 'locationId'> & { db: DealerCtx['db'] }): Promise<TieoutRow[]> {
  const { data, error } = await c.db
    .from('v_dealer_subledger_tieout')
    .select('bucket, account_id, account_number, account_name, subledger_cents, gl_cents, difference_cents')
    .eq('org_id', c.orgId)
    .eq('location_id', c.locationId);
  if (error) dbFail('Tie-out lookup failed', error);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    bucket: r.bucket as string,
    account_id: (r.account_id as string | null) ?? null,
    subledger_cents: Number(r.subledger_cents),
    gl_cents: Number(r.gl_cents),
    difference_cents: Number(r.difference_cents),
    ...(r.account_number ? { account_number: r.account_number as string } : {}),
  }));
}

export async function readiness(d: DealerCtx): Promise<Readiness> {
  const [settings, roleMap, missingRes, deptRes, tieRows] = await Promise.all([
    loadSettings(d),
    loadRoleMap(d),
    d.admin.rpc('dealer_pack_missing_requirements', { p_org: d.orgId, p_location: d.locationId }),
    d.db.from('dealer_department_map').select('dept_role, department_id').eq('org_id', d.orgId).eq('location_id', d.locationId),
    loadTieout(d),
  ]);
  if (missingRes.error) dbFail('Readiness check failed', missingRes.error);
  if (deptRes.error) dbFail('Department map lookup failed', deptRes.error);
  const missing = ((missingRes.data ?? []) as string[]) ?? [];
  const deptRows = (deptRes.data ?? []) as { dept_role: DeptRole; department_id: string }[];
  const tie = evaluateTieout(tieRows);
  const roles = (Object.keys(ROLE_SPEC) as DealerRole[]).map((r) => ({
    roleKey: r,
    label: ROLE_SPEC[r].label,
    required: ROLE_SPEC[r].required,
    accountId: roleMap.get(r)?.account_id ?? null,
    mappedDirectly: roleMap.get(r)?.mapped_directly ?? false,
    isNew: NEW_DEALER_ROLES.includes(r as never),
  }));
  return {
    enabled: settings.enabled,
    missing,
    roles,
    departments: DEPT_ROLES.map((dr) => ({ deptRole: dr, departmentId: deptRows.find((x) => x.dept_role === dr)?.department_id ?? null })),
    tieout: { ...tie, rows: tieRows },
    canEnable: missing.length === 0 && tie.ok,
  };
}

export async function setEnabled(d: DealerCtx, enabled: boolean): Promise<Readiness> {
  if (enabled) {
    const r = await readiness(d);
    if (r.missing.length > 0) {
      throw new DealerError('ENABLE_BLOCKED', 'Map every required account role and department role before enabling the dealer pack.', {
        missing: r.missing,
      });
    }
    if (!r.tieout.ok) {
      throw new DealerError('ENABLE_BLOCKED', 'The opening subledgers do not tie to the GL. Post the reconciling entry first.', {
        problems: r.tieout.problems,
      });
    }
  }
  const now = new Date().toISOString();
  const patch = enabled
    ? { enabled: true, enabled_at: now, enabled_by: d.userId, opening_tieout_at: now }
    : { enabled: false, disabled_at: now, disabled_by: d.userId };
  const { error } = await d.admin
    .from('dealer_pack_settings')
    .upsert({ ...patch, org_id: d.orgId, location_id: d.locationId, updated_by: d.userId }, { onConflict: 'org_id,location_id' });
  if (error) {
    if (/cannot be enabled/i.test(error.message)) throw new DealerError('ENABLE_BLOCKED', error.message);
    dbFail('Updating dealer pack status failed', error);
  }
  await audit(d, enabled ? 'pack.enable' : 'pack.disable', 'dealer_pack_settings', null,
    `${enabled ? 'Enabled' : 'Disabled'} the dealer pack for this client`);
  return readiness(d);
}
