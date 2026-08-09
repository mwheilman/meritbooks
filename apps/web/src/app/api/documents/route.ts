export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import {
  listDocumentsQuery,
  uploadMetaSchema,
  ALLOWED_MIME,
  MAX_DOCUMENT_BYTES,
  inferDocType,
  type DocType,
} from '@/lib/documents/schema';
import { listDocuments, uploadDocument } from '@/lib/documents/store';

/**
 * /api/documents — the Document Management Center store.
 *
 * GET  — list documents (RLS-scoped). Optional filters: entity_type[+entity_id] (a
 *        record's attachments), doc_type, and a filename search. Newest first.
 * POST — multipart upload. Retains the file in the private `documents` bucket and
 *        records its metadata row; optional (entity_type, entity_id) links it to the
 *        record it supports. Type + size validated server-side.
 *
 * Multipart uploads can't use the apiHandler JSON wrapper, so POST reads formData and
 * validates the metadata with the shared Zod schema by hand.
 */

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const parsed = listDocumentsQuery.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  try {
    const documents = await listDocuments({
      supabase: ctx.supabase,
      entityType: parsed.data.entity_type ?? null,
      entityId: parsed.data.entity_id ?? null,
      docType: parsed.data.doc_type ?? null,
      search: parsed.data.search ?? null,
      linked: parsed.data.linked ?? null,
      dateFrom: parsed.data.date_from ?? null,
      dateTo: parsed.data.date_to ?? null,
    });
    return NextResponse.json({ data: documents });
  } catch (err) {
    console.error('[documents] list failed:', err);
    return NextResponse.json({ error: 'Failed to load documents', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'File is empty', code: 'EMPTY_FILE' }, { status: 422 });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json({ error: 'File exceeds the 25 MB limit', code: 'TOO_LARGE' }, { status: 422 });
  }
  if (file.type && !ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}`, code: 'BAD_TYPE' },
      { status: 422 },
    );
  }

  const metaParsed = uploadMetaSchema.safeParse({
    doc_type: form?.get('doc_type') ?? undefined,
    entity_type: form?.get('entity_type') ?? undefined,
    entity_id: form?.get('entity_id') ?? undefined,
    notes: form?.get('notes') ?? undefined,
  });
  if (!metaParsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const meta = metaParsed.data;

  // If the uploader didn't choose a type, infer one from the filename/mime.
  const docType: DocType =
    form?.get('doc_type') ? meta.doc_type : inferDocType(file.name, file.type || null);

  try {
    const { document } = await uploadDocument({
      supabase,
      orgId,
      userId,
      file,
      docType,
      entityType: meta.entity_type ?? null,
      entityId: meta.entity_id ?? null,
      notes: meta.notes ?? null,
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (err) {
    console.error('[documents] upload failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed', code: 'UPLOAD_FAILED' },
      { status: 500 },
    );
  }
}
