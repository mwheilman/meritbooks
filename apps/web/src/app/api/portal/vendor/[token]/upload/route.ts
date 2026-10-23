export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The AI read of a certificate runs in-request so the vendor sees the result.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { storeSourceDocument } from '@/lib/documents/store-source';
import {
  validatePortalToken,
  touchTokenUsage,
  assertSafeUpload,
  assertSafeUploadBytes,
  docKindToDocType,
  isPortalDocKind,
  PORTAL_DOC_LABEL,
} from '@/lib/portal/vendor/tokens';
import { sharedRateLimiter, clientIp, retryAfterSeconds } from '@/lib/security/rate-limit';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { recordSubmission, requirementSetForVendor, runAiCheck } from '@/lib/vendor-compliance/review';
import { openBankChange } from '@/lib/vendor-compliance/bank-change';
import { portalItem } from '@/lib/vendor-compliance/portal';
import { consumePortalAiRead } from '@/lib/portal/vendor/ai-budget';

// Abuse throttle for this UNAUTHENTICATED endpoint (15 MB uploads, no session).
// Short window, generous enough that a real vendor uploading a few documents is
// never touched; a hostile client looping uploads is capped per-token AND per-IP.
const UPLOAD_PER_TOKEN = { windowMs: 60_000, max: 12 } as const;
const UPLOAD_PER_IP = { windowMs: 60_000, max: 30 } as const;

/**
 * POST /api/portal/vendor/[token]/upload — a vendor sends a document.
 *
 * SECURITY (public, no tenant session):
 *  • The token in the path is the sole credential. We validate it server-side
 *    with the service-role client and resolve org_id + vendor_id FROM THE ROW —
 *    the client never supplies (and cannot influence) which vendor/org it writes.
 *  • Revoked / expired / unknown tokens are rejected before any file is read.
 *  • The uploaded doc-kind must be one this token actually requested (narrowing).
 *  • Only small PDF/JPG/PNG files are accepted (type + extension + size cap) AND the
 *    bytes must really be one (magic numbers); the file is stored with the SNIFFED type.
 *  • AI reads are capped per link per UTC day in the DB (M11, lib/portal/vendor/ai-budget);
 *    over the cap the file is still stored and queued for a person.
 *  • The file lands in the private `documents` bucket linked to the vendor; a W-9 / COI
 *    becomes a vendor_document_submissions row WAITING FOR REVIEW (migration 180). A
 *    public upload never flips the vendor to compliant or lifts a hold — a person
 *    accepts it in Vendor compliance → Review queue.
 *  • A COI is read by AI (COI_EXTRACT, Core gateway) and checked against the vendor's
 *    requirement set; the result is shown back to the vendor. AI down → "a person will
 *    check it". W-9 images are not sent to AI unless VENDOR_PORTAL_W9_AI=on (D6).
 *  • A BANKING upload opens a pending bank-change call-back (VN-10): payments to the
 *    vendor are held until someone verifies by phone at a number already on file. The
 *    optional phone the vendor types is recorded as the number NOT to call back.
 *  • The response carries only this vendor's own check results.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const ip = clientIp(req);
  const throttle = sharedRateLimiter.checkAll([
    { key: `vendor-upload:token:${params.token}`, rule: UPLOAD_PER_TOKEN },
    { key: `vendor-upload:ip:${ip}`, rule: UPLOAD_PER_IP },
  ]);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: 'Too many uploads in a short time. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(throttle)) } },
    );
  }

  const admin = createAdminSupabase();

  // 1. Validate the token → resolve org + vendor from the row (never the client).
  const result = await validatePortalToken(admin, params.token);
  if (!result.ok) {
    const msg =
      result.state === 'expired'
        ? 'This upload link has expired. Contact your requester for a new link.'
        : result.state === 'revoked'
          ? 'This upload link has been revoked. Contact your requester for a new link.'
          : 'This upload link is not valid.';
    return NextResponse.json({ error: msg }, { status: result.state === 'not_found' ? 404 : 410 });
  }
  const { tokenId, orgId, vendorId, requestedDocs } = result.token;

  // 2. Parse multipart.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const rawKind = form.get('doc_kind');
  if (!isPortalDocKind(rawKind)) {
    return NextResponse.json({ error: 'Choose which document you are uploading.' }, { status: 400 });
  }
  if (!requestedDocs.includes(rawKind)) {
    return NextResponse.json({ error: 'That document was not requested for this link.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'A file is required.' }, { status: 400 });
  }

  // 3. File-safety guard (type + extension + size).
  const guard = assertSafeUpload({ fileName: file.name, mimeType: file.type || null, size: file.size });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const sniff = assertSafeUploadBytes({ fileName: file.name, mimeType: file.type || null, size: file.size }, bytes);
  if (!sniff.ok) {
    return NextResponse.json({ error: sniff.error }, { status: 400 });
  }
  // Store (and later serve) with the type the bytes ARE, never the client's claim.
  const safeFile = new File([bytes], file.name, { type: sniff.mimeType });

  // 4. Retain the file, stamped with the TOKEN-DERIVED org + vendor.
  const stored = await storeSourceDocument({
    supabase: admin,
    orgId,
    userId: null,
    file: safeFile,
    docType: docKindToDocType(rawKind),
    entityType: 'vendor',
    entityId: vendorId,
    notes: `Vendor portal submission · ${PORTAL_DOC_LABEL[rawKind]} · pending review`,
  });
  if (!stored) {
    return NextResponse.json({ error: 'We could not store that file. Please try again in a moment.' }, { status: 502 });
  }
  await touchTokenUsage(admin, tokenId);
  const actor = `vendor_token:${tokenId}`;

  // 5a. Banking → pending call-back (VN-10).
  if (rawKind === 'BANKING') {
    const phone = typeof form.get('contact_phone') === 'string' ? String(form.get('contact_phone')).trim().slice(0, 40) : '';
    try {
      await openBankChange(orgId, { vendorId, source: 'vendor_portal', documentId: stored.documentId, requestPhone: phone || null, openedBy: actor, notes: 'Banking document uploaded through the vendor portal.' }, admin);
    } catch (e) {
      console.error('[vendor-portal] bank change record failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'We stored your file but could not record the change. Please try again.' }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      doc_kind: rawKind,
      file_name: stored.fileName,
      message: 'Received. Before paying to new bank details, your customer will call you at a phone number they already have on file to confirm the change.',
    });
  }

  // 5b. W-9 / COI → a submission waiting for review, then the AI read (COI) + rule check.
  try {
    const sub = await recordSubmission(admin, { orgId, vendorId, docKind: rawKind, source: 'portal_upload', documentId: stored.documentId, portalTokenId: tokenId, actor });
    const allowW9Ai = process.env.VENDOR_PORTAL_W9_AI === 'on';
    const anthropicApiKey = getAnthropicApiKey();
    // Only charge the per-link AI budget when the model would actually be called.
    const wouldCallAi = !!anthropicApiKey && (rawKind === 'COI' || allowW9Ai);
    const budget = wouldCallAi ? await consumePortalAiRead(orgId, tokenId, { writer: admin }) : null;
    const checked = await runAiCheck(admin, sub, { base64: bytes.toString('base64'), mediaType: sniff.mimeType }, {
      anthropicApiKey,
      allowW9Ai,
      aiDeniedNote: budget && !budget.ok ? budget.note : null,
    });
    const [{ data: org }, set] = await Promise.all([
      admin.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle(),
      requirementSetForVendor(admin, orgId, vendorId).catch(() => null),
    ]);
    const item = portalItem(rawKind, checked, false, set, ((org as { name?: string } | null)?.name ?? '').trim() || 'Your customer');
    return NextResponse.json({ ok: true, doc_kind: rawKind, file_name: stored.fileName, message: item.status, item });
  } catch (e) {
    console.error('[vendor-portal] submission failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: true, doc_kind: rawKind, file_name: stored.fileName, message: 'Received — a person will check it.' });
  }
}
