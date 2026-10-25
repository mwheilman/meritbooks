export const dynamic = 'force-dynamic';

/**
 * POST /api/residential/jobs/:jobId/field-co (multipart) — the crew's change-order request from the
 * field in one tap (RES-37 / 39): photos and a voice note are filed on the job, then
 * pm.res_request_field_co opens the change order with "do not proceed until signed" (unless it is
 * an emergency, which proceeds and is documented). Fields: title, note, transcript, area,
 * demoDiscovery, emergency, photo (repeatable), voice.
 */
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { field, mimeOf } from '@/lib/documents/http';
import { createDocument, recordPhotoMeta, storeObject } from '@/lib/documents/store';
import { resRpc } from '@/lib/residential/rpc';

const MAX_PHOTOS = 12;
const MAX_BYTES = 25 * 1024 * 1024;

export const POST = route({ access: { cap: 'projects.change_orders', action: 'create' }, mask: false }, async ({ req, db, params, tenant, userId }) => {
  const job = params.jobId!;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Send the request as an upload.', 'BAD_UPLOAD');
  }
  const title = field(form, 'title', 200);
  if (!title) throw new HttpError(422, 'Say what you found.', 'VALIDATION');
  const photos = form.getAll('photo').filter((f): f is File => f instanceof File && f.size > 0);
  const voice = form.get('voice');
  if (photos.length > MAX_PHOTOS) throw new HttpError(422, `Attach up to ${MAX_PHOTOS} photos.`, 'VALIDATION');
  for (const f of [...photos, ...(voice instanceof File && voice.size > 0 ? [voice] : [])]) {
    if (f.size > MAX_BYTES) throw new HttpError(422, `${f.name} is over 25 MB.`, 'TOO_LARGE');
  }
  for (const f of photos) if (!mimeOf(f).startsWith('image/')) throw new HttpError(422, `${f.name} is not a photo.`, 'VALIDATION');

  const store = async (f: File, kind: 'photo' | 'file', label: string) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const obj = await storeObject(db, { orgId: tenant.orgId, userId }, { area: kind === 'photo' ? 'photos' : 'docs', fileName: f.name || `${label}.bin`, mimeType: mimeOf(f), bytes, kind });
    await createDocument(db, obj, { jobId: job, companyId: null }, { title: `${title} — ${label}`, kind, tags: ['change-order-request'] });
    if (kind === 'photo') await recordPhotoMeta(db, obj, bytes, { jobId: job, companyId: null }, { tzOffsetMinutes: 0, area: field(form, 'area', 80), deviceTakenAt: null });
    return obj.documentId;
  };
  // Photos are filed first (createDocument removes an object it could not file); they stay on the
  // job as evidence even if the change order itself is refused.
  const photoIds: string[] = [];
  for (const [i, f] of photos.entries()) photoIds.push(await store(f, 'photo', `photo ${i + 1}`));
  const voiceId = voice instanceof File && voice.size > 0 ? await store(voice, 'file', 'voice note') : null;
  const id = await resRpc<string>(db, 'res_request_field_co', {
    p_job: job, p_title: title, p_note: field(form, 'note', 4000), p_transcript: field(form, 'transcript', 8000), p_photo_documents: photoIds,
    p_voice_document: voiceId, p_demo_discovery: field(form, 'demoDiscovery', 5) === 'true', p_emergency: field(form, 'emergency', 5) === 'true', p_area: field(form, 'area', 120),
  });
  return { changeOrderId: id, photos: photoIds.length, voice: !!voiceId };
});
