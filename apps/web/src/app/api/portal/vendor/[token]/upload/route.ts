export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { storeSourceDocument } from '@/lib/documents/store-source';
import {
  validatePortalToken,
  touchTokenUsage,
  assertSafeUpload,
  docKindToDocType,
  isPortalDocKind,
  PORTAL_DOC_LABEL,
} from '@/lib/portal/vendor/tokens';

/**
 * POST /api/portal/vendor/[token]/upload — the ONLY write a vendor can make.
 *
 * SECURITY (public, no tenant session):
 *  • The token in the path is the sole credential. We validate it server-side
 *    with the service-role client and resolve org_id + vendor_id FROM THE ROW —
 *    the client never supplies (and cannot influence) which vendor/org it writes.
 *  • Revoked / expired / unknown tokens are rejected before any file is read.
 *  • The uploaded doc-kind must be one this token actually requested (narrowing).
 *  • Only small PDF/JPG/PNG files are accepted (type + extension + size cap).
 *  • The file lands in the private `documents` bucket linked to the vendor as a
 *    PENDING-review artifact. We deliberately DO NOT write vendor_compliance_docs,
 *    so a public upload can never flip the vendor to compliant or lift a payment
 *    hold — a human accepts it later in the vendor's Compliance drawer.
 *  • The response reveals nothing about the tenant beyond a generic confirmation.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
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
    // 410 Gone for a link that existed but is no longer usable; 404 otherwise.
    return NextResponse.json({ error: msg }, { status: result.state === 'not_found' ? 404 : 410 });
  }
  const { tokenId, orgId, vendorId, requestedDocs } = result.token;

  // 2. Parse multipart. Reject non-multipart bodies cleanly.
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
  // Narrowing: the vendor may only upload a document THIS token asked for.
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

  // 4. Retain the file in the `documents` bucket, linked to the vendor, stamped
  //    with the TOKEN-DERIVED org + vendor. Service-role client + explicit org_id;
  //    the vendor supplies bytes only. This is a PENDING-review artifact — nothing
  //    about the vendor's compliance or hold status changes here.
  const stored = await storeSourceDocument({
    supabase: admin,
    orgId,
    userId: null,
    file,
    docType: docKindToDocType(rawKind),
    entityType: 'vendor',
    entityId: vendorId,
    notes: `Vendor portal submission · ${PORTAL_DOC_LABEL[rawKind]} · pending review`,
  });

  if (!stored) {
    return NextResponse.json(
      { error: 'We could not store that file. Please try again in a moment.' },
      { status: 502 },
    );
  }

  // 5. Record usage on the token (best-effort).
  await touchTokenUsage(admin, tokenId);

  return NextResponse.json({
    ok: true,
    doc_kind: rawKind,
    file_name: stored.fileName,
    message: 'Received — your document is pending review.',
  });
}
