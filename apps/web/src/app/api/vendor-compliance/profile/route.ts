export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { profileBody } from '@/lib/validations/vendor-compliance';
import { setVendorProfile } from '@/lib/vendor-compliance/admin';
import { noOrg, vcError, vcManage } from '@/lib/vendor-compliance/route-auth';

/** POST /api/vendor-compliance/profile — classify a vendor (picks its requirement set). compliance:manage. */
export const POST = apiHandler(profileBody, async (b, { userId, orgId, supabase }) => {
  const guard = await vcManage(userId, '/api/vendor-compliance/profile');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const { data: v } = await supabase.schema('core').from('vendors').select('id').eq('org_id', orgId).eq('id', b.vendor_id).maybeSingle();
  if (!v) return NextResponse.json({ error: 'Vendor not found', code: 'NOT_FOUND' }, { status: 404 });
  try {
    await setVendorProfile(orgId, b.vendor_id, { vendorType: b.vendor_type, workType: b.work_type }, userId);
    return NextResponse.json({ ok: true, message: 'Classification saved.' });
  } catch (e) {
    return vcError(e);
  }
});
