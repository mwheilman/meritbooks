export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { uploadSet, listSets, listSheets } from '@/lib/documents/drawings';
import { field, readUpload, uuidField } from '@/lib/documents/http';
import { MAX_SET_BYTES } from '@/lib/documents/store';
import { SET_KINDS, type SetKind } from '@/lib/documents/types';

/** GET /api/documents/drawings?jobId= — the job's sets and sheets (current revision of each). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false, query: z.object({ jobId: z.string().uuid() }) }, async ({ db, query }) => {
  const [sets, sheets] = await Promise.all([listSets(db, query.jobId), listSheets(db, query.jobId)]);
  return { sets, sheets };
});

const Pages = z.array(z.object({
  index: z.number().int().min(0).max(1000),
  sheetNumber: z.string().trim().max(40).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  discipline: z.string().trim().max(40).nullable().optional(),
  revision: z.string().trim().max(20).nullable().optional(),
  extraction: z.enum(['text', 'manual', 'none']).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
})).max(1000);

/**
 * POST /api/documents/drawings (multipart: file = the PDF set, jobId, name, setKind, issuedOn,
 * pages = JSON [{index, sheetNumber, title, discipline, revision, extraction, confidence}] from
 * the browser's text layer, corrected by the uploader). Splits the set into one PDF per sheet;
 * the set stays in review until it is published.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false }, async ({ req, db, tenant, userId }) => {
  const up = await readUpload(req, { maxBytes: MAX_SET_BYTES, pdfOnly: true });
  const jobId = uuidField(up.form, 'jobId');
  if (!jobId) throw new HttpError(422, 'Pick the job this set belongs to.', 'VALIDATION');
  const kindRaw = field(up.form, 'setKind', 20) ?? 'ifc';
  if (!(SET_KINDS as readonly string[]).includes(kindRaw)) throw new HttpError(422, 'Pick the kind of set.', 'VALIDATION');
  const issuedOn = field(up.form, 'issuedOn', 10);
  if (issuedOn && !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) throw new HttpError(422, 'Issue date must be a date.', 'VALIDATION');
  let pages: z.infer<typeof Pages> = [];
  const raw = field(up.form, 'pages', 2_000_000);
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(422, 'The sheet list is not valid.', 'VALIDATION'); }
    const r = Pages.safeParse(parsed);
    if (!r.success) throw new HttpError(422, 'The sheet list is not valid.', 'VALIDATION');
    pages = r.data;
  }
  const name = field(up.form, 'name', 120) ?? up.file.name.replace(/\.pdf$/i, '').slice(0, 120);
  return { ok: true, ...(await uploadSet(db, { orgId: tenant.orgId, userId }, { jobId, name, setKind: kindRaw as SetKind, issuedOn, fileName: up.file.name, bytes: up.bytes, pages })) };
});
