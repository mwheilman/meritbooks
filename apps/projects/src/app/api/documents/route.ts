export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { field, readUpload, uuidField } from '@/lib/documents/http';
import { createDocument, listFiles, MAX_FILE_BYTES, recordPhotoMeta, storeObject } from '@/lib/documents/store';
import { DOC_KINDS, MONEY_CAPS, type DocKind, type MoneyCap } from '@/lib/documents/types';

const Query = z.object({
  jobId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  kind: z.enum(DOC_KINDS).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived', 'deleted']).optional(),
});

/** GET /api/documents — documents on the caller's jobs (RLS: job reach + money documents need the money capability). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false, query: Query }, async ({ db, tenant, query }) => {
  const companyIds = query.companyId ? [query.companyId] : tenant.activeCompanyId ? [tenant.activeCompanyId] : tenant.companies.map((c) => c.id);
  if (query.companyId) assertCompany(tenant, query.companyId);
  return { files: await listFiles(db, { companyIds, jobId: query.jobId, folderId: query.folderId, kind: query.kind, q: query.q, status: query.status }) };
});

/**
 * POST /api/documents (multipart) — upload a new document: file, jobId (or companyId for a
 * company-level file), title, kind, folderId, description, tags (comma list), moneyCap.
 * Photos also record EXIF time / GPS / device next to the server's receive time (tzOffset =
 * the browser's getTimezoneOffset(), used only when the camera wrote no offset).
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async ({ req, db, tenant, userId }) => {
  const up = await readUpload(req, { maxBytes: MAX_FILE_BYTES });
  const jobId = uuidField(up.form, 'jobId');
  const companyId = uuidField(up.form, 'companyId');
  if (!jobId && !companyId) throw new HttpError(422, 'Pick the job (or company) the document belongs to.', 'VALIDATION');
  if (companyId) assertCompany(tenant, companyId);
  const kindRaw = field(up.form, 'kind', 40);
  const isImage = up.mimeType.startsWith('image/');
  const kind: DocKind = kindRaw && (DOC_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as DocKind) : isImage ? 'photo' : 'file';
  const moneyRaw = field(up.form, 'moneyCap', 40);
  const moneyCap = moneyRaw && (MONEY_CAPS as readonly string[]).includes(moneyRaw) ? (moneyRaw as MoneyCap) : null;
  const tags = (field(up.form, 'tags', 400) ?? '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20).map((t) => t.slice(0, 40));
  const obj = await storeObject(db, { orgId: tenant.orgId, userId }, { area: kind === 'photo' ? 'photos' : 'docs', fileName: up.file.name, mimeType: up.mimeType, bytes: up.bytes, kind });
  const created = await createDocument(db, obj, { jobId, companyId }, {
    title: field(up.form, 'title', 200) ?? undefined, kind, folderId: uuidField(up.form, 'folderId'), moneyCap,
    description: field(up.form, 'description'), tags, label: field(up.form, 'label', 40), note: field(up.form, 'note', 1000),
  });
  if (kind === 'photo' || isImage) {
    const tz = Number(field(up.form, 'tzOffset', 6) ?? 0);
    await recordPhotoMeta(db, obj, up.bytes, { jobId, companyId }, { tzOffsetMinutes: Number.isFinite(tz) ? tz : 0, area: field(up.form, 'area', 80), deviceTakenAt: field(up.form, 'takenAt', 40) });
  }
  return { ok: true, ...created };
});
