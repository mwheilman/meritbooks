export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall, xone, xrows } from '@/lib/dealer/rpc';
import { Uuid } from '@/lib/dealer/schemas';

/** One import: its diff against the estimate and its lines (500 at a time). */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: 'estimate', query: z.object({ page: z.coerce.number().int().min(0).max(1000).default(0) }) }, async ({ db, params, query }) => {
  const pm = db.schema('pm');
  const imp = await xone<Record<string, unknown> & { id: string }>(pm.from('mfg_cad_imports').select('id, job_id, work_order_id, source, file_name, status, estimate_id, counts, diff, created_at, applied_at').eq('id', params.importId!).maybeSingle(), 'CAD import', 'That CAD import was not found.');
  const lines = await xrows<Record<string, unknown>>(pm.from('mfg_cad_lines').select('id, line_no, line_kind, assembly_ref, part_code, label_id, description, material, qty, uom, length_mm, width_mm, thickness_mm, grain, edgeband, machining').eq('import_id', imp.id).order('line_no').range(query.page * 500, query.page * 500 + 499), 'CAD lines');
  return { import: imp, lines, page: query.page };
});

/** Apply: the cut list becomes the work order's BOM (lines from an earlier import are replaced). */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: 'estimate', body: z.object({ op: z.literal('apply'), workOrderId: Uuid.nullish() }) }, async ({ db, params, body }) =>
  xcall(db, 'mfg_apply_cad_import', { p_import: params.importId!, p_work_order: body.workOrderId ?? null }));
