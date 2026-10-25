export const dynamic = 'force-dynamic';
export const maxDuration = 60;

import { createHash } from 'node:crypto';
import { boundedInflate } from '@/lib/imports/inflate';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { FEATURE_IMPORT_MAP, aiConfigured, runAiSafe } from '@/lib/ai/gateway';
import { aiAssistMapping, type AiRunner } from '@/lib/imports/ai-hook';
import { buildPreview, firstPass, isFailure, MAX_UPLOAD_BYTES, readUpload } from '@/lib/imports/engine';
import { previewReport } from '@/lib/imports/reports';
import { savedMappings, stageImport } from '@/lib/imports/server';
import { IMPORT_ENTITIES, SOURCE_SYSTEMS, type ImportEntity, type SourceSystem } from '@/lib/imports/types';
import { companyJobTypes } from '@/lib/onboarding/load';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/imports/preview — multipart: file (CSV / .xlsx ≤ 8 MB), companyId, source?, entity?,
 * overrides? (JSON field → header | null), openOnly? ("0" brings finished jobs too), ai? ("off").
 * Reads the file, detects the source, maps the columns (rules; the AI hook only for leftovers and
 * only while AI is running — it is paused today, so this is rules-only), validates every row and
 * STAGES the batch (pm.import_stage; the same file re-stages the same batch). Returns the preview:
 * the 0–3 columns worth a look, the validation report, the first 50 rows and the entity report.
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' } }, async ({ req, db, tenant, userId }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Send the export as a file upload.', 'BAD_UPLOAD');
  }
  const companyId = String(form.get('companyId') ?? '');
  if (!UUID.test(companyId)) throw new HttpError(422, 'Pick the company these records belong to.', 'VALIDATION');
  assertCompany(tenant, companyId);
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'Drop a CSV or Excel file.', 'VALIDATION');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is over 8 MB. Export open work only, or split it, and drop it again.', 'TOO_BIG');
  const src = String(form.get('source') ?? '');
  const ent = String(form.get('entity') ?? '');
  const source = (SOURCE_SYSTEMS as readonly string[]).includes(src) ? (src as SourceSystem) : null;
  const entity = (IMPORT_ENTITIES as readonly string[]).includes(ent) ? (ent as ImportEntity) : null;
  let overrides: Record<string, string | null> | undefined;
  const rawOverrides = form.get('overrides');
  if (typeof rawOverrides === 'string' && rawOverrides) {
    try {
      const o = JSON.parse(rawOverrides) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        overrides = Object.fromEntries(Object.entries(o as Record<string, unknown>)
          .filter(([k, v]) => /^[a-z_]{2,40}$/.test(k) && (v === null || (typeof v === 'string' && v.length <= 200)))) as Record<string, string | null>;
      }
    } catch {
      throw new HttpError(422, 'The column choices could not be read.', 'VALIDATION');
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const table = readUpload(file.name, file.type, bytes, boundedInflate());
  if (isFailure(table)) throw new HttpError(422, table.message, 'UNREADABLE');
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const [saved, jobTypes] = await Promise.all([savedMappings(db, companyId), companyJobTypes(db, companyId)]);

  const fp = firstPass(table, { source, entity, saved, overrides });
  const runner: AiRunner | null = form.get('ai') !== 'off' && aiConfigured()
    ? (r) => runAiSafe({ ...r, orgId: tenant.orgId, userId, feature: FEATURE_IMPORT_MAP })
    : null;
  const ai = await aiAssistMapping({ entity: fp.entity, unmappedHeaders: fp.unmappedHeaders, unmappedFields: fp.unmappedFields, records: table.records, runner });
  const preview = buildPreview(table, { fileHash, source, entity, saved, overrides, ai, jobTypes, openOnly: form.get('openOnly') !== '0' });
  const staged = await stageImport(db, companyId, preview);
  const today = new Date().toISOString().slice(0, 10);
  return {
    batchId: staged.batch_id,
    staged,
    preview: { ...preview, rows: preview.rows.slice(0, 50), rowsShown: Math.min(50, preview.rows.length) },
    entityReport: previewReport(preview.entity, preview.rows, today),
    importerReport: staged.report?.agreements ?? null,
  };
});
