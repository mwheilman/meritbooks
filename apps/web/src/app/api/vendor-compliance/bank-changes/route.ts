export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { bankChangeBody } from '@/lib/validations/vendor-compliance';
import { BANK_CHANGE_COLUMNS, openBankChange, rejectBankChange, verifyBankChange, type BankChangeRow } from '@/lib/vendor-compliance/bank-change';
import { noOrg, vcError, vcManage, vcView } from '@/lib/vendor-compliance/route-auth';

/**
 * VN-10 bank-change call-backs.
 *   GET   pending first, then the last 50 decided, with vendor names and the phone on the
 *         vendor record (the number to call). compliance:view.
 *   POST  verify (who called, when, whom, which number and where it came from — never the
 *         number on the request; the maker cannot verify) · reject · open (a change reported
 *         by phone / email). compliance:manage. Read through RLS first, service-role write.
 */
export const GET = apiQueryHandler(null, async (_q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/bank-changes');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const [{ data: pending }, { data: decided }] = await Promise.all([
    supabase.from('vendor_bank_change_verifications').select(BANK_CHANGE_COLUMNS).eq('org_id', orgId).eq('status', 'pending').order('opened_at', { ascending: true }).limit(200),
    supabase.from('vendor_bank_change_verifications').select(BANK_CHANGE_COLUMNS).eq('org_id', orgId).neq('status', 'pending').order('decided_at', { ascending: false }).limit(50),
  ]);
  const rows = [...((pending ?? []) as BankChangeRow[]), ...((decided ?? []) as BankChangeRow[])];
  const ids = Array.from(new Set(rows.map((r) => r.vendor_id)));
  const { data: vendors } = ids.length ? await supabase.schema('core').from('vendors').select('id, name, display_name, phone').eq('org_id', orgId).in('id', ids) : { data: [] };
  const byId = new Map(((vendors ?? []) as Array<{ id: string; name: string; display_name: string | null; phone: string | null }>).map((v) => [v.id, v]));
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, vendor_name: byId.get(r.vendor_id)?.display_name || byId.get(r.vendor_id)?.name || 'Vendor', vendor_phone: byId.get(r.vendor_id)?.phone ?? null })),
  });
});

export const POST = apiHandler(bankChangeBody, async (b, { userId, orgId, supabase }) => {
  const guard = await vcManage(userId, '/api/vendor-compliance/bank-changes');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  try {
    if (b.action === 'open') {
      const { data: v } = await supabase.schema('core').from('vendors').select('id').eq('org_id', orgId).eq('id', b.vendor_id).maybeSingle();
      if (!v) return NextResponse.json({ error: 'Vendor not found', code: 'NOT_FOUND' }, { status: 404 });
      const row = await openBankChange(orgId, {
        vendorId: b.vendor_id,
        source: 'manual',
        newBankName: b.new_bank_name ?? null,
        newAccountMask: b.new_account_last4 ? `****${b.new_account_last4}` : null,
        requestPhone: b.request_phone ?? null,
        openedBy: userId,
        notes: b.notes ?? null,
      });
      return NextResponse.json({ row, message: 'Recorded. Payments to this vendor are held until someone else verifies by call-back.' }, { status: 201 });
    }
    const { data: visible } = await supabase.from('vendor_bank_change_verifications').select('id').eq('org_id', orgId).eq('id', b.id).maybeSingle();
    if (!visible) return NextResponse.json({ error: 'Bank change not found', code: 'NOT_FOUND' }, { status: 404 });
    if (b.action === 'verify') {
      const row = await verifyBankChange(orgId, b.id, { actor: userId, phoneUsed: b.phone_used, phoneSource: b.phone_source, contactName: b.contact_name, calledAt: b.called_at ?? null, notes: b.notes ?? null });
      return NextResponse.json({ row, message: 'Verified. Payments to this vendor can be released again.' });
    }
    const row = await rejectBankChange(orgId, b.id, { actor: userId, reason: b.reason });
    return NextResponse.json({ row, message: 'Rejected and recorded.' });
  } catch (e) {
    return vcError(e);
  }
});
