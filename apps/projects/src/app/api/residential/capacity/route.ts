export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Day, Text, Uuid } from '@/lib/residential/schemas';

export interface CapacityRow {
  resource_kind: 'CREW' | 'VENDOR' | 'EMPLOYEE';
  resource_id: string;
  resource: string;
  week: string;
  busy_days: number;
  capacity_days: number;
  max_jobs_in_a_day: number;
  double_booked_days: number;
  overloaded: boolean;
}

/** Crews and key trades across every open job by week (RES-49): busy days vs capacity, double-booked days. */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: z.object({ company: Uuid, from: Day.optional(), weeks: z.coerce.number().int().min(1).max(26).default(8) }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.company);
    return resRpc<{ from: string; to: string; rows: CapacityRow[]; flags: number }>(db, 'res_crew_capacity', { p_location: query.company, p_from: query.from ?? null, p_weeks: query.weeks });
  });

const Body = z.object({ companyId: Uuid, resourceKind: z.enum(['CREW', 'VENDOR', 'EMPLOYEE']), resourceId: Uuid, label: Text(120).nullish(),
  daysPerWeek: z.number().int().min(1).max(7), maxJobsPerDay: z.number().int().min(1).max(20) });

/** Set one resource's capacity (days per week, jobs it can run in a day). */
export const POST = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  resWrote(await pm(db).from('res_resource_capacity').upsert({ org_id: tenant.orgId, location_id: body.companyId, resource_kind: body.resourceKind, resource_id: body.resourceId,
    label: body.label ?? null, days_per_week: body.daysPerWeek, max_jobs_per_day: body.maxJobsPerDay, updated_at: new Date().toISOString() },
    { onConflict: 'org_id,location_id,resource_kind,resource_id' }).select('id'));
  return { ok: true };
});
