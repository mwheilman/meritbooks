export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall } from '@/lib/dealer/rpc';
import { CompanyQ, IsoDate, Text, Uuid } from '@/lib/dealer/schemas';

/** The install board: crews by day, with the shop-completion and site-ready conflicts flagged. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: CompanyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  return xcall(db, 'mfg_install_board', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null });
});

const Body = z.object({
  jobId: Uuid, startsOn: IsoDate, endsOn: IsoDate, crewId: Uuid.nullish(), siteReadyOn: IsoDate.nullish(), wbsId: Uuid.nullish(),
  installId: Uuid.nullish(), notes: Text(1000).nullish(), status: z.enum(['PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'DONE', 'CANCELLED']).nullish(),
});

/**
 * Book or move an install (conflicts come back with the booking; the board shows them). Dispatch OR
 * production edit on the job may book: the route admits job viewers and pm.mfg_schedule_install's
 * guard decides (the database is the boundary).
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, body: Body }, async ({ db, body }) => {
  if (body.endsOn < body.startsOn) throw new HttpError(422, 'The install ends before it starts.', 'VALIDATION');
  return xcall(db, 'mfg_schedule_install', { p_job: body.jobId, p_starts_on: body.startsOn, p_ends_on: body.endsOn, p_crew: body.crewId ?? null, p_site_ready_on: body.siteReadyOn ?? null, p_wbs: body.wbsId ?? null, p_install: body.installId ?? null, p_notes: body.notes ?? null, p_status: body.status ?? null });
});
