export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { reviewAction, reviewQueueQuery } from '@/lib/validations/vendor-compliance';
import { acceptSubmission, rejectSubmission, SUBMISSION_COLUMNS, type SubmissionRow } from '@/lib/vendor-compliance/review';
import { noOrg, vcError, vcManage, vcView } from '@/lib/vendor-compliance/route-auth';

/**
 * Review queue (FPB §5.4 / §19.2).
 *   GET  open submissions (received / AI-checked), oldest first, with vendor names —
 *        or the last 100 decided (`status=decided`). RLS read as the member. compliance:view.
 *   POST accept (one click; AI down → keyed coverage lines) or reject with a reason
 *        (opens a correction request). compliance:manage. The submission is first READ
 *        through the member's RLS client (proves it is in their org), then the service
 *        role writes (180 tables are member-SELECT-only).
 */
export const GET = apiQueryHandler(reviewQueueQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/review');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const decided = q.status === 'decided';
  let query = supabase.from('vendor_document_submissions').select(SUBMISSION_COLUMNS).eq('org_id', orgId);
  query = decided ? query.in('status', ['accepted', 'rejected']).order('reviewed_at', { ascending: false }) : query.in('status', ['received', 'ai_checked']).order('created_at', { ascending: true });
  const { data, error } = await query.limit(decided ? 100 : 200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as SubmissionRow[];
  const ids = Array.from(new Set(rows.map((r) => r.vendor_id)));
  const { data: vendors } = ids.length
    ? await supabase.schema('core').from('vendors').select('id, name, display_name, email').eq('org_id', orgId).in('id', ids)
    : { data: [] };
  const names = new Map(((vendors ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null }>).map((v) => [v.id, { name: v.display_name || v.name, email: v.email }]));
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, vendor_name: names.get(r.vendor_id)?.name ?? 'Vendor', vendor_email: names.get(r.vendor_id)?.email ?? null })),
  });
});

export const POST = apiHandler(reviewAction, async (b, { userId, orgId, supabase }) => {
  const guard = await vcManage(userId, '/api/vendor-compliance/review');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const { data: visible } = await supabase.from('vendor_document_submissions').select('id').eq('org_id', orgId).eq('id', b.id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'Submission not found', code: 'NOT_FOUND' }, { status: 404 });
  const admin = serviceWriter();
  try {
    if (b.action === 'accept') {
      const res = await acceptSubmission(admin, orgId, b.id, {
        actor: userId,
        note: b.note ?? null,
        coverages: b.coverages,
        certificateHolder: b.certificate_holder,
        additionalInsured: b.additional_insured,
        waiverOfSubrogation: b.waiver_of_subrogation,
        carrier: b.carrier,
        policyNumber: b.policy_number,
        apply1099Signal: b.apply_1099_signal,
      });
      const message = res.holdLifted
        ? `Accepted. The payment hold is lifted${res.billsReleased ? ` and ${res.billsReleased} held bill${res.billsReleased === 1 ? '' : 's'} went back to the approval queue` : ''}.`
        : res.stillOnHold
          ? `Accepted. Still on hold: ${res.remaining.join(' ')}`
          : 'Accepted.';
      return NextResponse.json({ ...res, message });
    }
    const { data: m } = await admin.schema('core').from('users').select('id').eq('clerk_user_id', userId).maybeSingle();
    const uid = (m as { id?: string } | null)?.id;
    const { data: ms } = uid ? await admin.schema('core').from('memberships').select('id').eq('org_id', orgId).eq('user_id', uid).maybeSingle() : { data: null };
    const res = await rejectSubmission(admin, orgId, b.id, { actor: userId, reason: b.reason, ownerMembershipId: (ms as { id?: string } | null)?.id ?? null });
    const message = res.noEmail
      ? 'Rejected. The vendor has no email address, so add one to send the correction request.'
      : res.requestCreated
        ? 'Rejected. A correction request quoting your reason goes out with the next reminder run.'
        : 'Rejected. The vendor already has an open request; it keeps reminding them.';
    return NextResponse.json({ ...res, message });
  } catch (e) {
    return vcError(e);
  }
});
