/**
 * resolveUploadedFile — the single ingress for a drop-and-parse document, in BOTH
 * shapes:
 *
 *   1. LARGE-FILE path — `application/json { storagePath }`. The browser uploaded the
 *      file DIRECTLY to the private `documents` bucket via a signed upload URL
 *      (see POST /api/uploads/sign), bypassing Vercel's ~4.5MB serverless request-body
 *      limit. Here we download the bytes server-side (no body limit) and hand back
 *      base64 for the AI gateway.
 *   2. SMALL-FILE path — multipart `file` (≤~4.5MB). Backward-compatible with the
 *      original direct upload.
 *
 * TENANT ISOLATION: a JSON storagePath MUST live under this org's `intake/{orgId}/`
 * prefix — a caller can never point the parser at another tenant's object.
 *
 * Returns the decoded file, or a NextResponse error to return verbatim.
 */

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export const DOCUMENTS_BUCKET = 'documents';
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15MB, well above the doc set we see
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface ResolvedUpload {
  base64Data: string;
  mediaType: string;
  fileName: string;
  sizeBytes: number;
  /** The storage path, when the file was uploaded via storage (for retention/linking). */
  storagePath: string | null;
}

function mediaTypeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

export async function resolveUploadedFile(
  request: Request,
  orgId: string,
): Promise<ResolvedUpload | NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';

  // ── Large-file path: JSON { storagePath } ──────────────────────────────────
  if (contentType.includes('application/json')) {
    let storagePath = '';
    try {
      const body = (await request.json()) as { storagePath?: unknown };
      storagePath = typeof body?.storagePath === 'string' ? body.storagePath : '';
    } catch {
      return NextResponse.json({ error: 'Invalid request body', code: 'BAD_BODY' }, { status: 400 });
    }
    if (!storagePath) {
      return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    }
    const prefix = `intake/${orgId}/`;
    if (!storagePath.startsWith(prefix) || storagePath.includes('..')) {
      return NextResponse.json({ error: 'Invalid file path', code: 'BAD_PATH' }, { status: 403 });
    }
    const admin = createAdminSupabase();
    const { data, error } = await admin.storage.from(DOCUMENTS_BUCKET).download(storagePath);
    if (error || !data) {
      return NextResponse.json({ error: 'Could not read the uploaded file', code: 'DOWNLOAD_FAILED' }, { status: 400 });
    }
    const sizeBytes = data.size;
    if (sizeBytes > UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 15MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    const mediaType = data.type && ALLOWED.includes(data.type) ? data.type : mediaTypeFromName(storagePath);
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json({ error: `Unsupported file type: ${mediaType}.`, code: 'BAD_FILE_TYPE' }, { status: 400 });
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    const fileName = storagePath.split('/').pop() ?? 'document';
    return { base64Data: buffer.toString('base64'), mediaType, fileName, sizeBytes, storagePath };
  }

  // ── Small-file path: multipart form ────────────────────────────────────────
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    const mediaType = file.type || mediaTypeFromName(file.name);
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json({ error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' }, { status: 400 });
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 15MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    return { base64Data: buffer.toString('base64'), mediaType, fileName: file.name || 'document', sizeBytes: file.size, storagePath: null };
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }
}
