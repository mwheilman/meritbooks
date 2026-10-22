export const dynamic = 'force-dynamic';

import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { downs, dwrite } from '@/lib/pm/dealer/rpc';
import { loadPhotos } from '@/lib/pm/dealer/unit-queries';

const MAX_BYTES = 12 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * Add a photo to a unit: the file goes to the org's folder in the private `documents` bucket
 * (storage policies key on the first folder = org id), a public.documents row records it, and a
 * pm.document_links row ties it to the unit (job_id stays empty for unit photos, 1109 §0.5).
 */
export const POST = route({}, async ({ req, db, params, tenant, userId }) => {
  const u = await downs<{ id: string; location_id: string }>(db, 'assets', 'id, location_id', params.unitId!, 'That unit was not found.');
  assertCompany(tenant, u.location_id);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Send the photo as a file upload.', 'BAD_UPLOAD');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'Pick a photo to add.', 'VALIDATION');
  if (!TYPES.has(file.type)) throw new HttpError(422, 'Photos must be JPEG, PNG, WebP or HEIC.', 'VALIDATION');
  if (file.size > MAX_BYTES) throw new HttpError(422, 'That photo is over 12 MB. Send a smaller one.', 'VALIDATION');
  const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const path = `${tenant.orgId}/dealer/units/${u.id}/${crypto.randomUUID()}.${ext}`;
  const up = await db.storage.from('documents').upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) throw new HttpError(422, 'The photo did not upload. Try again.', 'UPLOAD_FAILED');
  const doc = await dwrite<Array<{ id: string }>>(
    db.from('documents').insert({ org_id: tenant.orgId, storage_path: path, file_name: file.name.slice(0, 200) || `photo.${ext}`, mime_type: file.type, size_bytes: file.size, doc_type: 'OTHER', entity_type: 'pm.assets', entity_id: u.id, uploaded_by_user: userId }).select('id'),
    'record the photo',
  );
  if (!doc[0]) throw new HttpError(500, 'The photo was not recorded. Try again.', 'CREATE_FAILED');
  await dwrite(db.schema('pm').from('document_links').insert({ document_id: doc[0].id, subject_table: 'assets', subject_id: u.id, role: 'photo' }).select('id'), 'link the photo');
  return { ok: true, photos: await loadPhotos(db, 'assets', u.id) };
});
