export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getSignedUrl } from '@/lib/documents/store';
import { fetchCoreMap } from '@/lib/stitch-core';
import { requirePermission } from '@/lib/rbac/require-permission';

interface ReceiptDetailRow {
  id: string;
  source: string;
  image_url: string | null;
  document_id: string | null;
  submitted_at: string;
  submitted_by_user: string | null;
  receipt_date: string | null;
  status: string;
  vendor_name: string | null;
  amount_cents: number | null;
  ai_confidence: number | null;
  ai_extracted_data: Record<string, unknown> | null;
  chase_reminder_count: number;
  gl_entry_id: string | null;
  bank_transaction_id: string | null;
  location_id: string;
  vendor_id: string | null;
  account_id: string | null;
  department_id: string | null;
  class_id: string | null;
  card_assignment_id: string | null;
  memo: string | null;
  job_id: string | null;
  match_status: string;
  match_score: number | null;
  match_candidate_txn_id: string | null;
  match_method: string | null;
  matched_at: string | null;
  extraction_status: string;
  flags: string[] | null;
  account: { account_number: string; name: string } | Array<{ account_number: string; name: string }> | null;
}

/**
 * GET /api/receipts/[id] — one receipt for the detail panel: a short-lived signed URL for
 * the file (private `documents` bucket, ownership proven by the RLS row read), the read
 * (AI or rules), the match (charge, method, score), the cardholder and the chase count.
 * receipts:view. account is public (embed OK); core rows are stitched in JS.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/[id]' });
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('receipts')
    .select(`
      id, source, image_url, document_id, submitted_at, submitted_by_user, receipt_date, status,
      vendor_name, amount_cents, ai_confidence, ai_extracted_data,
      chase_reminder_count, gl_entry_id, bank_transaction_id,
      location_id, vendor_id, account_id, department_id, class_id, card_assignment_id, memo, job_id,
      match_status, match_score, match_candidate_txn_id, match_method, matched_at, extraction_status, flags,
      account:accounts!receipts_account_id_fkey(account_number, name)
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
  const r = data as unknown as ReceiptDetailRow;

  const [locMap, venMap, deptMap, jobMap] = await Promise.all([
    fetchCoreMap<{ id: string; name: string; short_code: string }>(supabase, 'locations', 'id, name, short_code', [r.location_id]),
    fetchCoreMap<{ id: string; name: string }>(supabase, 'vendors', 'id, name', [r.vendor_id]),
    fetchCoreMap<{ id: string; name: string; code: string }>(supabase, 'departments', 'id, name, code', [r.department_id]),
    fetchCoreMap<{ id: string; name: string; job_number: string | null }>(supabase, 'jobs', 'id, name, job_number', [r.job_id]),
  ]);

  let file: { url: string; fileName: string; mimeType: string | null } | null = null;
  if (r.document_id) {
    try {
      const { data: doc } = await supabase.from('documents').select('mime_type').eq('id', r.document_id).maybeSingle();
      const mimeType = (doc as { mime_type?: string | null } | null)?.mime_type ?? null;
      // Only inert types open inline. Anything else (e.g. an HTML e-receipt stored before
      // HTML was converted on capture) is served as a download, never rendered.
      const inline = mimeType !== null && /^(application\/pdf|image\/(jpeg|png|gif|webp|heic|heif)|text\/plain)$/i.test(mimeType);
      const signed = await getSignedUrl(supabase, r.document_id, 600, { download: !inline });
      if (signed) file = { ...signed, mimeType: inline ? mimeType : 'application/octet-stream' };
    } catch {
      file = null;
    }
  }

  const txnIds = [r.bank_transaction_id, r.match_candidate_txn_id].filter((x): x is string => !!x);
  const txns = new Map<string, { id: string; description: string; amount_cents: number; transaction_date: string }>();
  if (txnIds.length) {
    const { data: ts } = await supabase.from('bank_transactions').select('id, description, amount_cents, transaction_date').in('id', txnIds);
    for (const t of (ts ?? []) as Array<{ id: string; description: string; amount_cents: number; transaction_date: string }>) txns.set(t.id, t);
  }
  const charge = (id: string | null) => {
    const t = id ? txns.get(id) : null;
    return t ? { id: t.id, description: t.description, amountCents: Math.abs(Number(t.amount_cents)), date: t.transaction_date } : null;
  };
  let holder: { name: string; email: string | null } | null = null;
  if (r.card_assignment_id) {
    const { data: h } = await supabase.from('card_assignments').select('holder_name, holder_email').eq('id', r.card_assignment_id).maybeSingle();
    const hh = h as { holder_name: string; holder_email: string | null } | null;
    holder = hh ? { name: hh.holder_name, email: hh.holder_email } : null;
  }

  const acct = Array.isArray(r.account) ? r.account[0] : r.account;
  const loc = locMap.get(r.location_id) ?? null;
  const dept = r.department_id ? deptMap.get(r.department_id) ?? null : null;
  const job = r.job_id ? jobMap.get(r.job_id) ?? null : null;
  const extraction = (r.ai_extracted_data?.extraction ?? null) as Record<string, unknown> | null;

  return NextResponse.json({
    id: r.id,
    source: r.source,
    file,
    imageUrl: file?.url ?? r.image_url,
    submittedAt: r.submitted_at,
    receiptDate: r.receipt_date,
    status: r.status,
    vendorName: r.vendor_name ?? (r.vendor_id ? venMap.get(r.vendor_id)?.name ?? null : null),
    amountCents: r.amount_cents != null ? Number(r.amount_cents) : null,
    aiConfidence: r.ai_confidence != null ? Number(r.ai_confidence) : null,
    accountLabel: acct ? `${acct.account_number} · ${acct.name}` : null,
    locationId: r.location_id,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    departmentLabel: dept ? `${dept.code} · ${dept.name}` : null,
    jobLabel: job ? `${job.job_number ? `${job.job_number} · ` : ''}${job.name}` : null,
    memo: r.memo,
    holder,
    chaseReminderCount: r.chase_reminder_count,
    posted: !!r.gl_entry_id,
    matchStatus: r.match_status,
    matchScore: r.match_score != null ? Number(r.match_score) : null,
    matchMethod: r.match_method,
    matchedAt: r.matched_at,
    matchedCharge: charge(r.bank_transaction_id),
    suggestedCharge: r.match_status === 'suggested' ? charge(r.match_candidate_txn_id) : null,
    extractionStatus: r.extraction_status,
    extraction: extraction
      ? {
          source: typeof extraction.source === 'string' ? extraction.source : null,
          subtotalCents: typeof extraction.subtotalCents === 'number' ? extraction.subtotalCents : null,
          taxCents: typeof extraction.taxCents === 'number' ? extraction.taxCents : null,
          tipCents: typeof extraction.tipCents === 'number' ? extraction.tipCents : null,
          cardLast4: typeof extraction.cardLast4 === 'string' ? extraction.cardLast4 : null,
          note: typeof extraction.note === 'string' ? extraction.note : null,
        }
      : null,
    flags: r.flags ?? [],
  });
}
