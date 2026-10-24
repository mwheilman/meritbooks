export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope, serviceWriter } from '@/lib/db/scoped-writer';
import { chaseBody, chaseQuery } from '@/lib/validations/vendor-compliance';
import { chaseSwitches, createVendorDocRequest, planVendorChase, type VendorNeed } from '@/lib/requests/vendor-compliance';
import { loadPolicyContext } from '@/lib/requests/policy';
import { quietHoursSummary } from '@/lib/requests/quiet-display';
import { setChaseSwitch } from '@/lib/vendor-compliance/admin';
import { noOrg, vcError, vcManage, vcSettings, vcView } from '@/lib/vendor-compliance/route-auth';
import { consumeSendQuota } from '@/lib/email/send-quota';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * Automatic W-9 / COI chase (FPB §19 A8).
 *   GET   the switches (firm + per company) and the PREVIEW: every vendor that would be
 *         emailed if the switch were on, and why not for the rest. Read as the member.
 *         compliance:view.
 *   POST  switch — firm-wide or one company, per policy (w9 · coi · coi_renewal); default
 *         off. compliance:manage + settings_system:edit; company asserted in scope.
 *         request_now — one vendor, now, whatever the switch (metered). compliance:manage.
 */
export const GET = apiQueryHandler(chaseQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/chase');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const ctx = await loadPolicyContext(supabase, orgId);
  const sw = chaseSwitches(ctx);
  const [preview, live] = await Promise.all([
    planVendorChase({ db: supabase, now: () => new Date() }, orgId, { ctx, locationId: q.location_id ?? null, forceOn: true }),
    planVendorChase({ db: supabase, now: () => new Date() }, orgId, { ctx, locationId: q.location_id ?? null }),
  ]);
  const liveStatus = new Map(live.items.map((i) => [`${i.vendor.id}:${i.need.kind}:${i.need.renewal ? 'r' : ''}`, i.status]));
  return NextResponse.json({
    switches: { org: sw.org, byCompany: Object.fromEntries(sw.byCompany) },
    // The quiet hours the reminder run actually keeps (same resolver), for the drawer's note.
    quietHours: quietHoursSummary(ctx),
    requirementSets: preview.requirementSets,
    vendorsChecked: preview.vendorsChecked,
    items: preview.items.map((i) => ({
      vendorId: i.vendor.id,
      vendorName: i.vendor.name,
      email: i.vendor.email,
      kind: i.need.kind,
      renewal: i.need.renewal,
      dueDate: i.need.dueDate,
      reason: i.need.reason ?? null,
      status: i.status,
      liveStatus: liveStatus.get(`${i.vendor.id}:${i.need.kind}:${i.need.renewal ? 'r' : ''}`) ?? i.status,
      why: i.why,
    })),
  });
});

export const POST = apiHandler(chaseBody, async (b, { userId, orgId, supabase }) => {
  if (!orgId) return noOrg();
  try {
    if (b.action === 'switch') {
      const guard = await vcSettings(userId, '/api/vendor-compliance/chase');
      if (!guard.ok) return guard.response;
      await assertWriteScope(supabase, orgId, [b.location_id]);
      await setChaseSwitch(orgId, b.location_id, b.key, b.on, userId);
      await logHumanAction(supabase, userId, orgId, {
        action: 'vendor_compliance.chase.switch',
        subjectTable: 'request_policies',
        locationId: b.location_id,
        summary: `Automatic ${b.key === 'w9' ? 'W-9' : b.key === 'coi' ? 'COI' : 'COI renewal'} chase turned ${b.on ? 'on' : 'off'}${b.location_id ? ' for one company' : ' firm-wide'}`,
      });
      return NextResponse.json({ ok: true, message: b.on ? 'On. The next reminder run (every 15 minutes) sends to the vendors listed.' : 'Off. Open requests keep running; no new ones are created automatically.' });
    }

    const guard = await vcManage(userId, '/api/vendor-compliance/chase');
    if (!guard.ok) return guard.response;
    const { data: v } = await supabase.schema('core').from('vendors').select('id, name, display_name, email').eq('org_id', orgId).eq('id', b.vendor_id).maybeSingle();
    if (!v) return NextResponse.json({ error: 'Vendor not found', code: 'NOT_FOUND' }, { status: 404 });
    const vendor = v as { id: string; name: string; display_name: string | null; email: string | null };
    if (!vendor.email) return NextResponse.json({ error: `${vendor.display_name || vendor.name} has no email address. Add one on the vendor to send the request.`, code: 'NO_EMAIL' }, { status: 422 });
    const q = await consumeSendQuota(orgId, userId, 1, 'request');
    if (!q.ok) return NextResponse.json({ error: q.error, code: q.code }, { status: q.status, headers: { 'Retry-After': String(q.retryAfterSec) } });
    const writer = serviceWriter();
    const deps = { db: writer, now: () => new Date() };
    const ctx = await loadPolicyContext(writer, orgId);
    // Ask for what the requirement set says is wrong (the preview's reason), else the plain ask.
    const plan = await planVendorChase({ db: supabase, now: deps.now }, orgId, { ctx, forceOn: true });
    const planned = plan.items.find((i) => i.vendor.id === vendor.id && i.need.kind === b.kind);
    const need: VendorNeed = planned?.need ?? (b.kind === 'w9' ? { kind: 'w9', docTypes: ['W9'], renewal: false, dueDate: null } : { kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null });
    const res = await createVendorDocRequest(deps, ctx, { orgId, vendor: { id: vendor.id, name: vendor.display_name || vendor.name, email: vendor.email }, need, createdBy: userId, source: 'manual' });
    return NextResponse.json(
      { request: { id: res.request.id, status: res.request.status, next_send_at: res.request.next_send_at }, created: res.created, message: res.created ? 'Requested. The email goes out with the next reminder run (within 15 minutes, outside the vendor’s quiet hours).' : 'Already being chased — see Requests for its schedule.' },
      { status: res.created ? 201 : 200 },
    );
  } catch (e) {
    return vcError(e);
  }
});
