export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { requirementBody } from '@/lib/validations/vendor-compliance';
import { loadRequirementSets } from '@/lib/vendor-compliance/store';
import { retireRequirementSet, saveRequirementSet } from '@/lib/vendor-compliance/admin';
import { noOrg, vcError, vcManage, vcView } from '@/lib/vendor-compliance/route-auth';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * Requirement sets (FPB §19 A1): what a vendor owes per company × vendor type × 1099
 * status × work type.
 *   GET   active sets + the companies the member can see. compliance:view.
 *   POST  save | retire. compliance:manage; the company is asserted inside the caller's
 *         org + client scope; service-role write; logged to core.action_log.
 */
export const GET = apiQueryHandler(null, async (_q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/requirements');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const [sets, { data: locs }] = await Promise.all([
    loadRequirementSets(supabase, orgId),
    supabase.schema('core').from('locations').select('id, name, is_active').eq('org_id', orgId).order('name'),
  ]);
  return NextResponse.json({
    sets,
    companies: ((locs ?? []) as Array<{ id: string; name: string; is_active: boolean | null }>).filter((l) => l.is_active !== false).map((l) => ({ id: l.id, name: l.name })),
  });
});

export const POST = apiHandler(requirementBody, async (b, { userId, orgId, supabase }) => {
  const guard = await vcManage(userId, '/api/vendor-compliance/requirements');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  try {
    if (b.action === 'retire') {
      const { data: visible } = await supabase.from('vendor_requirements').select('id, location_id, name').eq('org_id', orgId).eq('id', b.id).maybeSingle();
      if (!visible) return NextResponse.json({ error: 'Requirement set not found', code: 'NOT_FOUND' }, { status: 404 });
      await assertWriteScope(supabase, orgId, [(visible as { location_id: string | null }).location_id]);
      await retireRequirementSet(orgId, b.id, userId);
      await logHumanAction(supabase, userId, orgId, { action: 'vendor_compliance.requirements.retire', subjectTable: 'vendor_requirements', subjectId: b.id, summary: `Retired requirement set “${(visible as { name: string }).name}”` });
      return NextResponse.json({ ok: true, message: 'Requirement set retired. Vendors it governed fall back to the next most specific set.' });
    }
    if (b.id) {
      const { data: visible } = await supabase.from('vendor_requirements').select('id').eq('org_id', orgId).eq('id', b.id).maybeSingle();
      if (!visible) return NextResponse.json({ error: 'Requirement set not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    await assertWriteScope(supabase, orgId, [b.location_id]);
    const set = await saveRequirementSet(orgId, {
      id: b.id ?? null,
      name: b.name,
      locationId: b.location_id,
      vendorType: b.vendor_type,
      tax1099: b.tax_1099,
      workType: b.work_type,
      w9Required: b.w9_required,
      coiRequired: b.coi_required,
      minGlEachOccurrenceCents: b.min_gl_each_occurrence_cents,
      minGlAggregateCents: b.min_gl_aggregate_cents,
      minAutoCents: b.min_auto_cents,
      wcRequired: b.wc_required,
      minWcEachAccidentCents: b.min_wc_each_accident_cents,
      minUmbrellaCents: b.min_umbrella_cents,
      requireAdditionalInsured: b.require_additional_insured,
      requireWaiverOfSubrogation: b.require_waiver_of_subrogation,
      certificateHolderName: b.certificate_holder_name,
      expiryLeadDays: b.expiry_lead_days,
      blockPayment: b.block_payment,
      graceDays: b.grace_days,
    }, userId);
    await logHumanAction(supabase, userId, orgId, { action: 'vendor_compliance.requirements.save', subjectTable: 'vendor_requirements', subjectId: set.id, locationId: set.locationId, summary: `Saved requirement set “${set.name}”`, metadata: { block_payment: set.blockPayment, grace_days: set.graceDays } });
    return NextResponse.json({ set, message: 'Saved. Holds and the next chase run use it right away.' });
  } catch (e) {
    return vcError(e);
  }
});
