export const dynamic = 'force-dynamic';

import { portalHandler, portalJson } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { isPortalObjectPath, MAX_UPLOAD_BYTES, portalStorage, UPLOAD_TYPES } from '@/lib/portal/storage';
import { isUuid } from '@/lib/portal/tokens';
import { mimeOf } from '@/lib/documents/http';

/**
 * PUBLIC (session cookie): one file (multipart: orgId, purpose, file). The database opens a
 * one-time slot (portal.upload_begin), the bytes go to that exact key on the anon key (the storage
 * policy allows nothing else), then portal.upload_finish files the public.documents row.
 */
const PURPOSES = new Set(['photo', 'compliance', 'pay_app', 'message', 'request']);

export const POST = portalHandler({}, async ({ req, session }) => {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) return portalJson(413, { error: 'Files up to 25 MB.', code: 'invalid' });
  let form: FormData;
  try { form = await req.formData(); } catch { return portalJson(400, { error: 'Choose a file.', code: 'invalid' }); }
  const org = form.get('orgId'); const purpose = form.get('purpose'); const file = form.get('file');
  if (!isUuid(org) || typeof purpose !== 'string' || !PURPOSES.has(purpose) || !(file instanceof File)) {
    return portalJson(422, { error: 'Choose a file.', code: 'invalid' });
  }
  const type = mimeOf(file);
  if (!UPLOAD_TYPES[type]) return portalJson(422, { error: 'Upload a PDF or a photo (JPEG, PNG, WebP, HEIC).', code: 'invalid' });
  if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) return portalJson(422, { error: 'Files up to 25 MB.', code: 'invalid' });
  const name = file.name || `upload.${UPLOAD_TYPES[type]}`;
  const slot = await portalRpc<{ upload_id: string; path: string }>('upload_begin', {
    p_session: session, p_org: org, p_purpose: purpose, p_file_name: name.slice(0, 200), p_mime: type, p_size: file.size,
  });
  if (!isPortalObjectPath(slot.path, org)) return portalJson(503, { error: 'The upload could not start.', code: 'unavailable' });
  const ok = await portalStorage().upload(slot.path, await file.arrayBuffer(), type);
  if (!ok) return portalJson(503, { error: 'The upload did not finish. Try again.', code: 'unavailable' });
  const done = await portalRpc<{ document_id: string }>('upload_finish', { p_session: session, p_upload: slot.upload_id });
  return { ok: true, documentId: done.document_id, fileName: name.slice(0, 200) };
});
