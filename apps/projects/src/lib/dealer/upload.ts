import 'server-only';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { xrows } from './rpc';

const MAX_BYTES = 12 * 1024 * 1024;
const IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const FILES = new Set([...IMAGE, 'application/pdf', 'text/csv', 'text/plain', 'application/xml', 'text/xml']);

/**
 * One photo / signature / shipment file from the phone or the counter, filed in the org's folder of
 * the private `documents` bucket with a public.documents row (storage policies key on the first
 * folder = org id). Returns the document id; the 1125 RPC that uses it (finding, damage, POD, lot
 * scan, punch) keeps the id and links it. Never the service role.
 */
export async function storeUpload(
  req: NextRequest,
  db: SupabaseClient,
  who: { orgId: string; userId: string },
  o: { area: string; entityType: string; imagesOnly?: boolean },
): Promise<{ documentId: string; fileName: string; mimeType: string }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Send the file as an upload.', 'BAD_UPLOAD');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'Pick a file to add.', 'VALIDATION');
  const allowed = o.imagesOnly ? IMAGE : FILES;
  if (!allowed.has(file.type)) throw new HttpError(422, o.imagesOnly ? 'Photos must be JPEG, PNG, WebP or HEIC.' : 'That file type is not accepted here.', 'VALIDATION');
  if (file.size > MAX_BYTES) throw new HttpError(422, 'That file is over 12 MB. Send a smaller one.', 'VALIDATION');
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  const path = `${who.orgId}/${o.area}/${crypto.randomUUID()}.${ext}`;
  const up = await db.storage.from('documents').upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) throw new HttpError(422, 'The file did not upload. Try again.', 'UPLOAD_FAILED');
  const rows = await xrows<{ id: string }>(
    db.from('documents').insert({ org_id: who.orgId, storage_path: path, file_name: file.name.slice(0, 200) || `upload.${ext}`, mime_type: file.type, size_bytes: file.size,
      doc_type: 'OTHER', entity_type: o.entityType, uploaded_by_user: who.userId }).select('id'),
    'record the upload',
  );
  if (!rows[0]) throw new HttpError(500, 'The file was not recorded. Try again.', 'CREATE_FAILED');
  return { documentId: rows[0].id, fileName: file.name, mimeType: file.type };
}
