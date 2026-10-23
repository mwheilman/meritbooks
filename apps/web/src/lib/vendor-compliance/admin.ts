/**
 * Vendor compliance configuration writes: requirement sets, vendor classification, and the
 * automatic-chase switch (firm-wide or per company). Service role, org pinned; routes have
 * authorized the caller (compliance:manage; the switch also settings_system:edit) and
 * asserted the company is in their org + client scope before calling.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { logVendorComplianceEvent } from '@/lib/services/vendor-compliance-audit';
import { REQUIREMENT_COLUMNS, rowToSet, type RequirementRow, type RequirementSet, type Tax1099Scope, type VendorType } from './requirements';

type DB = SupabaseClient;

export class AdminError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface RequirementInput {
  id?: string | null;
  name: string;
  locationId: string | null;
  vendorType: VendorType | null;
  tax1099: Tax1099Scope;
  workType: string | null;
  w9Required: boolean;
  coiRequired: boolean;
  minGlEachOccurrenceCents: number | null;
  minGlAggregateCents: number | null;
  minAutoCents: number | null;
  wcRequired: boolean;
  minWcEachAccidentCents: number | null;
  minUmbrellaCents: number | null;
  requireAdditionalInsured: boolean;
  requireWaiverOfSubrogation: boolean;
  certificateHolderName: string | null;
  expiryLeadDays: number;
  blockPayment: boolean;
  graceDays: number;
}

/** Pure cross-field checks (the zod schema handles shapes). */
export function validateRequirement(i: RequirementInput): string | null {
  if (!i.name.trim()) return 'Name the requirement set.';
  if (!i.w9Required && !i.coiRequired && i.minGlEachOccurrenceCents === null && i.minAutoCents === null && !i.wcRequired && i.minUmbrellaCents === null) {
    return 'Require at least a W-9 or a certificate of insurance.';
  }
  const coiish = i.coiRequired || i.minGlEachOccurrenceCents !== null || i.minGlAggregateCents !== null || i.minAutoCents !== null || i.wcRequired || i.minWcEachAccidentCents !== null || i.minUmbrellaCents !== null;
  if (!coiish && (i.requireAdditionalInsured || i.requireWaiverOfSubrogation || i.certificateHolderName)) {
    return 'Endorsements and certificate holder only apply when a certificate of insurance is required.';
  }
  if (i.minGlAggregateCents !== null && i.minGlEachOccurrenceCents !== null && i.minGlAggregateCents < i.minGlEachOccurrenceCents) {
    return 'The general liability aggregate cannot be lower than the each-occurrence limit.';
  }
  if (i.workType && !/^[a-z0-9_]{1,40}$/.test(i.workType)) return 'Work type: lower-case letters, digits and underscores only.';
  return null;
}

function toRow(i: RequirementInput) {
  return {
    name: i.name.trim(),
    location_id: i.locationId,
    vendor_type: i.vendorType,
    tax_1099: i.tax1099,
    work_type: i.workType,
    w9_required: i.w9Required,
    coi_required: i.coiRequired || i.minGlEachOccurrenceCents !== null || i.minGlAggregateCents !== null,
    min_gl_each_occurrence_cents: i.minGlEachOccurrenceCents,
    min_gl_aggregate_cents: i.minGlAggregateCents,
    min_auto_cents: i.minAutoCents,
    wc_required: i.wcRequired || i.minWcEachAccidentCents !== null,
    min_wc_each_accident_cents: i.minWcEachAccidentCents,
    min_umbrella_cents: i.minUmbrellaCents,
    require_additional_insured: i.requireAdditionalInsured,
    require_waiver_of_subrogation: i.requireWaiverOfSubrogation,
    certificate_holder_name: i.certificateHolderName?.trim() || null,
    expiry_lead_days: i.expiryLeadDays,
    block_payment: i.blockPayment,
    grace_days: i.graceDays,
  };
}

export async function saveRequirementSet(orgId: string, input: RequirementInput, actor: string, writer?: DB, now: Date = new Date()): Promise<RequirementSet> {
  const problem = validateRequirement(input);
  if (problem) throw new AdminError(problem);
  const w = serviceWriter(writer);
  const row = { ...toRow(input), updated_by: actor, updated_at: now.toISOString() };
  const res = input.id
    ? await w.from('vendor_requirements').update(row).eq('org_id', orgId).eq('id', input.id).eq('is_active', true).select(REQUIREMENT_COLUMNS)
    : await w.from('vendor_requirements').insert({ ...row, org_id: orgId, is_active: true, created_by: actor, created_at: now.toISOString() }).select(REQUIREMENT_COLUMNS);
  if (res.error) {
    if (res.error.code === '23505' || /duplicate key|unique/i.test(res.error.message)) {
      throw new AdminError('There is already a requirement set for exactly that company, vendor type, 1099 status and work type — edit that one instead.', 409);
    }
    throw new AdminError(`Could not save the requirement set: ${res.error.message}`, 500);
  }
  const saved = (Array.isArray(res.data) ? res.data[0] : null) as RequirementRow | null;
  if (!saved) throw new AdminError('Requirement set not found.', 404);
  return rowToSet(saved);
}

export async function retireRequirementSet(orgId: string, id: string, actor: string, writer?: DB, now: Date = new Date()): Promise<void> {
  const { data, error } = await serviceWriter(writer)
    .from('vendor_requirements')
    .update({ is_active: false, updated_by: actor, updated_at: now.toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('is_active', true)
    .select('id');
  if (error) throw new AdminError(`Could not retire the requirement set: ${error.message}`, 500);
  if (!data || (Array.isArray(data) && data.length === 0)) throw new AdminError('Requirement set not found.', 404);
}

export async function setVendorProfile(
  orgId: string,
  vendorId: string,
  input: { vendorType: VendorType | null; workType: string | null },
  actor: string,
  writer?: DB,
  now: Date = new Date(),
): Promise<void> {
  if (input.workType && !/^[a-z0-9_]{1,40}$/.test(input.workType)) throw new AdminError('Work type: lower-case letters, digits and underscores only.');
  const w = serviceWriter(writer);
  const { data: existing } = await w.from('vendor_compliance_profiles').select('id').eq('org_id', orgId).eq('vendor_id', vendorId).maybeSingle();
  const patch = { vendor_type: input.vendorType, work_type: input.workType, updated_by: actor, updated_at: now.toISOString() };
  const { error } = existing
    ? await w.from('vendor_compliance_profiles').update(patch).eq('org_id', orgId).eq('id', (existing as { id: string }).id)
    : await w.from('vendor_compliance_profiles').insert({ ...patch, org_id: orgId, vendor_id: vendorId });
  if (error) throw new AdminError(`Could not save the vendor classification: ${error.message}`, 500);
  await logVendorComplianceEvent(w, orgId, vendorId, 'PROFILE_CHANGED', `Classified as ${input.vendorType ?? 'unclassified'}${input.workType ? ` · ${input.workType}` : ''}.`, { actor });
}

export type ChaseKey = 'w9' | 'coi' | 'coi_renewal';

/** Turn automatic chase on/off for the firm (locationId null) or one company. */
export async function setChaseSwitch(orgId: string, locationId: string | null, key: ChaseKey, on: boolean, actor: string, writer?: DB, now: Date = new Date()): Promise<void> {
  const w = serviceWriter(writer);
  let q = w.schema('core').from('request_policies').select('id').eq('org_id', orgId).eq('policy_key', key);
  q = locationId ? q.eq('location_id', locationId) : q.is('location_id', null);
  const { data: existing, error: readErr } = await q.maybeSingle();
  if (readErr) throw new AdminError(`Could not read the chase setting: ${readErr.message}`, 500);
  const { error } = existing
    ? await w.schema('core').from('request_policies').update({ auto_create: on, updated_by: actor, updated_at: now.toISOString() }).eq('org_id', orgId).eq('id', (existing as { id: string }).id)
    : await w.schema('core').from('request_policies').insert({ org_id: orgId, location_id: locationId, policy_key: key, auto_create: on, updated_by: actor, updated_at: now.toISOString() });
  if (error) throw new AdminError(`Could not save the chase setting: ${error.message}`, 500);
}
