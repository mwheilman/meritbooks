export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { vendorDetailQuery } from '@/lib/validations/vendor-compliance';
import { vendorTimeline } from '@/lib/vendor-compliance/dashboard';
import { SUBMISSION_COLUMNS } from '@/lib/vendor-compliance/review';
import { BANK_CHANGE_COLUMNS } from '@/lib/vendor-compliance/bank-change';
import { noOrg, vcView } from '@/lib/vendor-compliance/route-auth';

/**
 * GET /api/vendor-compliance/vendor?id= — one vendor's compliance file: timeline (requests,
 * sends, opens, uploads, AI checks, decisions, holds, bank changes), submissions (no TIN),
 * bank-change records, classification. RLS read as the member. compliance:view.
 */
export const GET = apiQueryHandler(vendorDetailQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/vendor');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const { data: vendor } = await supabase.schema('core').from('vendors').select('id, name, display_name, email, phone, is_1099_eligible, w9_status').eq('org_id', orgId).eq('id', q.id).maybeSingle();
  if (!vendor) return NextResponse.json({ error: 'Vendor not found', code: 'NOT_FOUND' }, { status: 404 });
  const [timeline, { data: submissions }, { data: bankChanges }, { data: profile }] = await Promise.all([
    vendorTimeline(supabase, orgId, q.id),
    supabase.from('vendor_document_submissions').select(SUBMISSION_COLUMNS).eq('org_id', orgId).eq('vendor_id', q.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('vendor_bank_change_verifications').select(BANK_CHANGE_COLUMNS).eq('org_id', orgId).eq('vendor_id', q.id).order('opened_at', { ascending: false }).limit(20),
    supabase.from('vendor_compliance_profiles').select('vendor_type, work_type').eq('org_id', orgId).eq('vendor_id', q.id).maybeSingle(),
  ]);
  return NextResponse.json({ vendor, timeline, submissions: submissions ?? [], bankChanges: bankChanges ?? [], profile: profile ?? null });
});
