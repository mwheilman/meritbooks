export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { CAD_SOURCES, parseCadFile } from '@/lib/mfg/cad-import';
import { JobQ, Req, Uuid } from '@/lib/dealer/schemas';

export interface CadImportRow {
  id: string;
  job_id: string;
  work_order_id: string | null;
  source: string;
  file_name: string;
  status: string;
  estimate_id: string | null;
  counts: Record<string, number>;
  diff: unknown;
  created_at: string;
  applied_at: string | null;
}

/** CAD imports on a job, newest first. */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: 'estimate', query: JobQ }, async ({ db, query }) => {
  const imports = await xrows<CadImportRow>(db.schema('pm').from('mfg_cad_imports').select('id, job_id, work_order_id, source, file_name, status, estimate_id, counts, diff, created_at, applied_at').eq('job_id', query.job).order('created_at', { ascending: false }).limit(50), 'CAD imports');
  return { imports };
});

const Body = z.object({
  jobId: Uuid,
  source: z.enum(CAD_SOURCES),
  fileName: Req(200, 'The file name'),
  text: z.string().min(1, 'The file is empty').max(15_000_000, 'Split files over 15 MB'),
  units: z.enum(['mm', 'in', 'auto']).default('auto'),
  workOrderId: Uuid.nullish(),
  wbsId: Uuid.nullish(),
  estimateId: Uuid.nullish(),
});

/** Parse the export in the app, stage it, and diff its material against the sold estimate. */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: 'estimate', body: Body }, async ({ db, body }) => {
  const parsed = parseCadFile(body.text, body.source, body.units);
  if (!parsed.lines.length) throw new HttpError(422, parsed.issues[0]?.message ?? 'No parts were found in that file.', 'VALIDATION');
  if (parsed.lines.length > 20_000) throw new HttpError(422, 'At most 20,000 lines per import. Split the job by room.', 'VALIDATION');
  const r = await xcall<Record<string, unknown>>(db, 'mfg_stage_cad_import', {
    p_job: body.jobId, p_source: body.source, p_file_name: body.fileName, p_lines: parsed.lines,
    p_work_order: body.workOrderId ?? null, p_wbs: body.wbsId ?? null, p_estimate: body.estimateId ?? null,
  });
  return { ...r, units: parsed.units, summary: parsed.summary, issues: parsed.issues.slice(0, 200) };
});
