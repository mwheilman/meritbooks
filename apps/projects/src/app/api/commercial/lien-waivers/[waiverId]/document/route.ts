export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { field, readUpload } from '@/lib/documents/http';
import { createDocument, MAX_FILE_BYTES, storeObject } from '@/lib/documents/store';
import { cmError, cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/lien-waivers/:id/document — upload the signed waiver (multipart: file,
 * amountCents, throughDate) and record it as received. Verification needs this copy on file and
 * a different person than the one uploading it.
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: ['commitment'] }, async ({ req, db, tenant, userId, params }) => {
  const id = params.waiverId!;
  const w = await db.schema('pm').from('cm_lien_waivers').select('id, job_id, form_key, compliance_doc_id').eq('id', id).maybeSingle();
  if (w.error) throw cmError(w.error);
  const row = w.data as { id: string; job_id: string; form_key: string | null; compliance_doc_id: string | null } | null;
  if (!row) throw new HttpError(404, 'That lien waiver was not found.', 'NOT_FOUND');
  const up = await readUpload(req, { maxBytes: MAX_FILE_BYTES });
  const amountRaw = field(up.form, 'amountCents', 20);
  const through = field(up.form, 'throughDate', 10);
  if (amountRaw !== null && !/^\d{1,13}$/.test(amountRaw)) throw new HttpError(422, 'Enter the amount on the waiver.', 'VALIDATION');
  if (through !== null && !/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new HttpError(422, 'Use a date like 2026-10-31.', 'VALIDATION');
  const obj = await storeObject(db, { orgId: tenant.orgId, userId }, { area: 'docs', fileName: up.file.name, mimeType: up.mimeType, bytes: up.bytes, kind: 'lien_waiver' });
  await createDocument(db, obj, { jobId: row.job_id, companyId: null }, { title: `Lien waiver ${row.form_key ?? ''}`.trim(), kind: 'lien_waiver', moneyCap: 'projects.financials' });
  const signed: Record<string, string | number> = {};
  if (amountRaw !== null) signed.amount_cents = Number(amountRaw);
  if (through !== null) signed.through_date = through;
  if (row.form_key) signed.form_key = row.form_key;
  return { id: await cmRpc<string>(db, 'cm_receive_lien_waiver', { p_waiver: id, p_document: obj.documentId, p_signed: signed }, 'commitment'), documentId: obj.documentId };
});
