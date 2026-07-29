export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/receipts/[id]
 * Full receipt for the detail drawer: the uploaded image plus AI-extracted
 * fields. account is public (embed OK); vendor/location/department/class are
 * in `core` and stitched in JS.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: r, error } = await supabase
    .from('receipts')
    .select(`
      id, source, image_url, submitted_at, receipt_date, status,
      vendor_name, amount_cents, ai_confidence, ai_extracted_data,
      chase_reminder_count, gl_entry_id, bank_transaction_id,
      location_id, vendor_id, account_id, department_id, class_id,
      account:accounts!receipts_account_id_fkey(account_number, name)
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !r) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });

  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [r.location_id]);
  const venMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase, 'vendors', 'id, name', [r.vendor_id]);
  const deptMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'departments', 'id, name, code', [r.department_id]);
  const classMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'classes', 'id, name, code', [r.class_id]);

  const acct = Array.isArray(r.account) ? r.account[0] : r.account;
  const loc = r.location_id ? locMap.get(r.location_id) ?? null : null;
  const dept = r.department_id ? deptMap.get(r.department_id) ?? null : null;
  const cls = r.class_id ? classMap.get(r.class_id) ?? null : null;

  return NextResponse.json({
    id: r.id,
    source: r.source,
    imageUrl: r.image_url,
    submittedAt: r.submitted_at,
    receiptDate: r.receipt_date,
    status: r.status,
    vendorName: r.vendor_name ?? (r.vendor_id ? venMap.get(r.vendor_id)?.name ?? null : null),
    amountCents: r.amount_cents,
    aiConfidence: r.ai_confidence,
    accountLabel: acct ? `${(acct as { account_number: string }).account_number} · ${(acct as { name: string }).name}` : null,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    departmentLabel: dept ? `${dept.code} · ${dept.name}` : null,
    classLabel: cls ? `${cls.code} · ${cls.name}` : null,
    chaseReminderCount: r.chase_reminder_count,
    posted: !!r.gl_entry_id,
    matchedToBank: !!r.bank_transaction_id,
  });
}
