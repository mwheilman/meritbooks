import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { approveTimeEntries } from '@/lib/approvals/server';
import { laborErrorCopy } from '@/lib/pm/labor/errors';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { TimesheetDay } from '@/lib/fieldservice/completion-types';
import { Day, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Timesheet review with exception flags (FS-102). GET: per tech per day — hours, entries and the
 * flags (long drive, unexplained gap, daily / weekly overtime, missing clock-out, finished visits
 * with no time, unsubmitted days), each with a proposed fix. POST approve: the submitted entries
 * through the 1113 approval engine (preparer ≠ approver, delegation, limits). No pay rates.
 */
const Q = z.object({ companyId: Uuid, from: Day.optional(), to: Day.optional() });

export const GET = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const r = await rpcLoad<TimesheetDay[]>(db, 'fs_timesheet_exceptions', { p_location: query.companyId, p_from: query.from ?? null, p_to: query.to ?? null,
    p_long_drive_minutes: 60, p_gap_minutes: 45 }, []);
  return { days: r.data, error: r.error };
});

function timeError(e: PgErrorLike): Error {
  const c = laborErrorCopy(e);
  return c ? new HttpError(c.status, c.error, c.code) : new PmQueryError('approve time', e);
}

export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false,
  body: z.object({ op: z.literal('approve'), entryIds: z.array(Uuid).min(1).max(500) }) }, async ({ db, body }) =>
  approveTimeEntries(db, body.entryIds, timeError));
