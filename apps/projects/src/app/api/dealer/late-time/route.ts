export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { IsoDate, Uuid } from '@/lib/dealer/schemas';

interface LateRow {
  id: string;
  job_id: string;
  employee_id: string | null;
  employee: string | null;
  work_date: string;
  hours: number;
  approval_state: string;
  late_tap_minutes: number | null;
  late_label: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  notes: string | null;
}

/**
 * GET /api/dealer/late-time?company=&from=&to= — time a technician's phone sent more than 15 minutes
 * after the tap (migration 1125, security review H1): "entered N h late", and whether an approver has
 * acknowledged it. Such an entry cannot be approved until it is acknowledged individually.
 */
export const GET = route({ access: { cap: 'projects.time', action: 'approve' }, mask: 'time_entry', query: z.object({ company: Uuid, from: IsoDate.optional(), to: IsoDate.optional() }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.company);
    const rows = await xcall<LateRow[]>(db, 'dlr_late_time', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null });
    return {
      entries: rows.map((r) => ({
        id: r.id, jobId: r.job_id, employeeId: r.employee_id, employee: r.employee, workDate: r.work_date, hours: Number(r.hours), approvalState: r.approval_state,
        lateTapMinutes: r.late_tap_minutes, lateLabel: r.late_label, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by, notes: r.notes,
      })),
    };
  });

/** Acknowledge late entries one by one (pm.dlr_ack_late_time); the normal approval path (Approvals) then approves them. */
const Body = z.object({ op: z.literal('ack'), ids: z.array(Uuid).min(1).max(200) });

export const POST = route({ access: { cap: 'projects.time', action: 'approve' }, mask: false, body: Body }, async ({ db, body }) => {
  const r = await xcall<{ acknowledged: number }>(db, 'dlr_ack_late_time', { p_ids: body.ids });
  return { acknowledged: r.acknowledged };
});
