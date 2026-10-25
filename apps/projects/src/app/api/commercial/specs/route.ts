export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { SpecImport } from '@/lib/commercial/screen-schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/specs?jobId= — the project manual's sections (CGC-62). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const r = await db.schema('pm').from('cm_spec_sections').select('id, job_id, number, title, division, revision, addendum, document_id, page_start, page_end, updated_at').eq('job_id', query.jobId).order('number');
  if (r.error) throw cmError(r.error);
  return { sections: r.data ?? [] };
});

/**
 * POST /api/commercial/specs — import sections from the manual's table of contents. A section
 * already on file keeps its number; an addendum import raises its revision and records the addendum.
 */
export const POST = route({ access: { cap: 'projects.documents', action: 'create' }, mask: false, body: SpecImport }, async ({ db, body }) => {
  const pm = db.schema('pm');
  let revs = new Map<string, number>();
  if (body.addendum) {
    const cur = await pm.from('cm_spec_sections').select('number, revision').eq('job_id', body.jobId).in('number', body.sections.map((s) => s.number));
    if (cur.error) throw cmError(cur.error);
    revs = new Map(((cur.data ?? []) as Array<{ number: string; revision: number }>).map((s) => [s.number, s.revision]));
  }
  const sections = body.sections.map((s) => ({
    number: s.number, title: s.title,
    ...(body.addendum ? { addendum: body.addendum, revision: revs.has(s.number) ? (revs.get(s.number) ?? 0) + 1 : 0 } : {}),
  }));
  return { imported: await cmRpc<number>(db, 'cm_import_spec_sections', { p_job: body.jobId, p_sections: sections }) };
});
