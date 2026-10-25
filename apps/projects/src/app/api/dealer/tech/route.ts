export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { inList, xcall, xrows } from '@/lib/dealer/rpc';
import { CompanyQ, Uuid } from '@/lib/dealer/schemas';

/** The productivity board: clocked vs flagged vs billed hours per tech, open punches, indirect time. */
export const GET = route({ access: { cap: 'projects.time', action: 'view' }, mask: ['repair_order', 'time_entry'], query: CompanyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const [board, ros] = await Promise.all([
    xcall<Record<string, unknown>>(db, 'dlr_tech_board', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null }),
    xrows<{ id: string; number: string; summary: string; status: string }>(pm.from('work_orders').select('id, number, summary, status').eq('location_id', query.company).eq('kind', 'REPAIR_ORDER').in('status', ['SCHEDULED', 'DISPATCHED', 'IN_PROGRESS', 'ON_HOLD']).order('number', { ascending: false }).limit(200), 'open repair orders'),
  ]);
  // Labor lines on open repair orders: what a tech clocks onto (no cost columns are read).
  const lines = await xrows<{ id: string; work_order_id: string; description: string; flag_hours: number | null; labor_minutes: number | null; status: string }>(
    pm.from('work_order_lines').select('id, work_order_id, description, flag_hours, labor_minutes, status').in('work_order_id', inList(ros.map((r) => r.id))).eq('kind', 'LABOR').order('sort'), 'repair order lines');
  return { ...board, ros, lines };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('clock_on'), lineId: Uuid, employeeId: Uuid.nullish() }),
  z.object({ op: z.literal('clock_off'), companyId: Uuid, employeeId: Uuid.nullish() }),
  z.object({ op: z.literal('indirect'), companyId: Uuid, kind: z.enum(['SHOP', 'WAITING_PARTS', 'TRAINING', 'CLEANUP', 'IDLE']), employeeId: Uuid.nullish() }),
  z.object({ op: z.literal('flag'), lineId: Uuid, flagHours: z.number().min(0).max(200) }),
]);

/** Clock on an RO line (closes any open punch first), clock off, indirect time, flag hours. */
export const POST = route({ access: { cap: 'projects.time', action: 'create' }, mask: ['repair_order', 'time_entry'], body: Op }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'clock_on':
      return xcall(db, 'dlr_clock_on', { p_line: body.lineId, p_employee: body.employeeId ?? null });
    case 'clock_off':
      assertCompany(tenant, body.companyId);
      return xcall(db, 'dlr_clock_off', { p_location: body.companyId, p_employee: body.employeeId ?? null, p_end_at: null });
    case 'indirect':
      assertCompany(tenant, body.companyId);
      return xcall(db, 'dlr_clock_indirect', { p_location: body.companyId, p_kind: body.kind, p_employee: body.employeeId ?? null });
    case 'flag':
      return { id: await xcall<string>(db, 'dlr_flag_line', { p_line: body.lineId, p_flag_hours: body.flagHours }) };
  }
});
