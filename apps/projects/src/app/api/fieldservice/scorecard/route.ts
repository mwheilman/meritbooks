import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { loadScorecard } from '@/lib/fieldservice/queries';
import { Day, Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ companyId: Uuid, from: Day, to: Day });

/**
 * Tech scorecards (FS-40/103) + performance pay inputs (FS-101). The database narrows rows (a tech
 * gets only their own), revenue (contract value or self) and pay (labor rates or self); the
 * response is masked again: pay keys are labor-rate money, revenue is contract money — except on
 * the caller's own row, which the database already decided.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  const r = await loadScorecard(db, query.companyId, query.from, query.to);
  return { rows: r.rows, error: r.error };
});
