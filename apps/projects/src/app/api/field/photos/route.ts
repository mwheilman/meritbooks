export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { NextResponse } from 'next/server';
import { applyPhoto, failure } from '../_lib/apply';
import { PhotoMetaZ } from '../_lib/contract';
import { commandResponse, fieldCtx } from '../_lib/handler';
import { BodyTooLargeError, PHOTO_BODY_MAX_BYTES, readLimited } from '../_lib/sniff';

function tooLarge(): NextResponse {
  return NextResponse.json(
    { id: '', kind: 'photo.upload', outcome: 'rejected', code: 'PHOTO_TOO_LARGE', reason: 'That photo is over 12 MB. Take it at a lower resolution.' },
    { status: 413, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * POST /api/field/photos — one photo from the phone (multipart: `file` + `meta`, a JSON photo
 * command). The phone writes every photo to its own storage first and sends it from the queue.
 * The body is capped BEFORE it is parsed: a Content-Length over the cap is refused outright, and
 * the stream is read with a hard limit (a missing or false Content-Length never buffers past it).
 * The photo's type is read from its own bytes, not the client's MIME.
 * The bytes go to the org's folder of the private `documents` bucket at a path made from the
 * command id (so a re-send is recognised), a public.documents row records it, and a
 * pm.document_links row ties it to the job — or to the log, checklist or punch item it was taken for.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async (rc) => {
  const declared = Number(rc.req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > PHOTO_BODY_MAX_BYTES) return tooLarge();
  const contentType = rc.req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;/i.test(contentType)) throw new HttpError(415, 'Send the photo as a multipart file upload.', 'BAD_UPLOAD');
  let form: FormData;
  try {
    const bytes = await readLimited(rc.req.body, PHOTO_BODY_MAX_BYTES);
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch (e) {
    if (e instanceof BodyTooLargeError) return tooLarge();
    throw new HttpError(400, 'Send the photo as a file upload.', 'BAD_UPLOAD');
  }
  const metaRaw = form.get('meta');
  let meta: unknown;
  try {
    meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : undefined;
  } catch {
    meta = undefined;
  }
  const parsed = PhotoMetaZ.safeParse(meta);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return commandResponse({ id: '', kind: 'photo.upload', outcome: 'rejected', code: 'VALIDATION', reason: first ? `${first.message} (${first.path.join('.') || 'meta'})` : 'The photo details are missing.' });
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return commandResponse({ id: parsed.data.id, kind: 'photo.upload', outcome: 'rejected', code: 'VALIDATION', reason: 'The photo file is missing. Take it again.' });
  }
  const ctx = fieldCtx(rc);
  try {
    const bytes = await file.arrayBuffer();
    const name = file instanceof File ? file.name : 'photo.jpg';
    return commandResponse(await applyPhoto(ctx, parsed.data, { bytes, name }));
  } catch (e) {
    return commandResponse(failure(parsed.data.id, 'photo.upload', e));
  }
});
