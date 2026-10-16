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

/** The DEFAULT accepted types — what the AI document parsers (debt, formation…) can read. */
export const PARSEABLE_DOC_TYPES: readonly string[] = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
];
/** Spreadsheet / plain-text types the deterministic importers (budget, AR/AP, TB) read. */
export const SPREADSHEET_TYPES: readonly string[] = [
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
/** Everything Smart Intake can open server-side (documents + spreadsheets). */
export const INTAKE_READABLE_TYPES: readonly string[] = [...PARSEABLE_DOC_TYPES, ...SPREADSHEET_TYPES];

const ALLOWED = PARSEABLE_DOC_TYPES;

export interface ResolveUploadOptions {
  /**
   * Media types this caller accepts. Defaults to PDF/images (the original behavior,
   * so existing callers like debt parse are unchanged). Pass SPREADSHEET_TYPES or
   * INTAKE_READABLE_TYPES to also accept CSV / XLSX / TXT.
   */
  allowedTypes?: readonly string[];
}

export interface ResolvedUpload {
  base64Data: string;
  mediaType: string;
  fileName: string;
  sizeBytes: number;
  /** The storage path, when the file was uploaded via storage (for retention/linking). */
  storagePath: string | null;
}

/** Media type from a file name's extension ('application/octet-stream' when unknown). */
export function mediaTypeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'txt' || ext === 'tsv') return 'text/plain';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

/**
 * Pick the effective media type. Spreadsheet/text files are resolved by EXTENSION first
 * (browsers report a .csv as `application/vnd.ms-excel` on Windows, which would be
 * mis-read as a workbook); PDFs/images keep the original reported-type-first rule so
 * the default (PDF/image) behavior is byte-for-byte unchanged.
 */
export function pickMediaType(reported: string | null | undefined, name: string, allowed: readonly string[]): string {
  const byName = mediaTypeFromName(name);
  if (SPREADSHEET_TYPES.includes(byName) && allowed.includes(byName)) return byName;
  if (reported && allowed.includes(reported)) return reported;
  return byName;
}

function unsupportedMessage(mediaType: string, allowed: readonly string[]): string {
  const sheets = allowed.some((t) => SPREADSHEET_TYPES.includes(t));
  return sheets
    ? `Unsupported file type: ${mediaType}. Upload a PDF, image, CSV, or .xlsx file.`
    : `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`;
}

export async function resolveUploadedFile(
  request: Request,
  orgId: string,
  opts: ResolveUploadOptions = {},
): Promise<ResolvedUpload | NextResponse> {
  const allowed = opts.allowedTypes ?? ALLOWED;
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
    const mediaType = pickMediaType(data.type, storagePath, allowed);
    if (!allowed.includes(mediaType)) {
      return NextResponse.json({ error: unsupportedMessage(mediaType, allowed), code: 'BAD_FILE_TYPE' }, { status: 400 });
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
    const mediaType = allowed === ALLOWED
      ? (file.type || mediaTypeFromName(file.name))
      : pickMediaType(file.type, file.name || '', allowed);
    if (!allowed.includes(mediaType)) {
      return NextResponse.json({ error: unsupportedMessage(mediaType, allowed), code: 'BAD_FILE_TYPE' }, { status: 400 });
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
