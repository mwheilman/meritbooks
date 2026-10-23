export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { documentQuery } from '@/lib/validations/vendor-compliance';
import { getSignedUrl } from '@/lib/documents/store';
import { createAdminSupabase } from '@/lib/supabase/server';
import { noOrg, vcView } from '@/lib/vendor-compliance/route-auth';
import { DocAccessError, inlineAllowed, isTinBearingDoc, revealTinDocument } from '@/lib/vendor-compliance/doc-access';

/**
 * GET /api/vendor-compliance/review/document?submission_id= — a 5-minute signed URL for the
 * submitted file, so the reviewer sees the document beside the extracted fields. Inline
 * only for PDF / JPEG / PNG (else forced download). A W-9 image shows the full TIN, so GET
 * refuses it (REVEAL_REQUIRED): POST { submission_id, reason } opens it for a role allowed
 * to reveal TINs, after the reveal is logged. Both the submission and the document row are
 * read through the member's RLS client (wrong tenant → 404, never a URL). compliance:view.
 */
async function load(supabase: ApiContext['supabase'], orgId: string, submissionId: string) {
  const { data: sub } = await supabase.from('vendor_document_submissions').select('document_id, doc_kind').eq('org_id', orgId).eq('id', submissionId).maybeSingle();
  const row = sub as { document_id?: string | null; doc_kind?: string } | null;
  const docId = row?.document_id ?? null;
  if (!docId) return null;
  const { data: doc } = await supabase.from('documents').select('mime_type, file_name, doc_type').eq('id', docId).maybeSingle();
  const d = doc as { mime_type?: string | null; doc_type?: string | null } | null;
  return { docId, mimeType: d?.mime_type ?? null, tinBearing: row?.doc_kind === 'W9' || isTinBearingDoc(d?.doc_type) };
}

const NO_FILE = () => NextResponse.json({ error: 'No file for this submission (it was typed into the portal).', code: 'NO_FILE' }, { status: 404 });

export const GET = apiQueryHandler(documentQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/review/document');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const f = await load(supabase, orgId, q.submission_id);
  if (!f) return NO_FILE();
  if (f.tinBearing) {
    return NextResponse.json({ error: 'This W-9 shows the full taxpayer ID. Open it with a reason (it is logged).', code: 'REVEAL_REQUIRED' }, { status: 403 });
  }
  const signed = await getSignedUrl(supabase, f.docId, 300, { download: !inlineAllowed(f.mimeType) });
  if (!signed) return NextResponse.json({ error: 'File not found', code: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ url: signed.url, fileName: signed.fileName, mimeType: f.mimeType });
});

const revealBody = z.object({ submission_id: z.string().uuid(), reason: z.string().trim().min(3).max(500) });

export const POST = apiHandler(revealBody, async (b, { userId, orgId, supabase }) => {
  const guard = await vcView(userId, '/api/vendor-compliance/review/document');
  if (!guard.ok) return guard.response;
  if (!orgId) return noOrg();
  const f = await load(supabase, orgId, b.submission_id);
  if (!f) return NO_FILE();
  try {
    const link = await revealTinDocument(createAdminSupabase(), supabase, {
      orgId, userId, documentId: f.docId, mimeType: f.mimeType, subjectTable: 'vendor_document_submissions', subjectId: b.submission_id, reason: b.reason,
    });
    return NextResponse.json(link);
  } catch (e) {
    if (e instanceof DocAccessError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
