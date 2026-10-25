export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { IsoDate, Uuid } from '@/lib/pm/money/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';
import { loadProductivityJob } from '@/lib/commercial/screens';
import type { ProductivityRow } from '@/lib/commercial/screen-types';

/**
 * GET /api/commercial/productivity/board?jobId=&asOf= — everything the productivity screen needs
 * for one job (CGC-89/90): earned vs actual hours by cost code, the budget units behind them, the
 * cost codes to log against, recent installed quantities and the fade alerts. Hours only.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid, asOf: IsoDate.optional() }) }, async ({ db, query }) => {
  const j = await db.schema('core').from('jobs').select('location_id').eq('id', query.jobId).maybeSingle();
  if (j.error) throw cmError(j.error);
  if (!j.data) throw new HttpError(404, 'That job was not found.', 'NOT_FOUND');
  const [rows, rest] = await Promise.all([
    cmRpc<ProductivityRow[]>(db, 'cm_labor_productivity', { p_job: query.jobId, p_as_of: query.asOf ?? null }),
    loadProductivityJob(db, query.jobId, (j.data as { location_id: string }).location_id),
  ]);
  return { rows, ...rest };
});
