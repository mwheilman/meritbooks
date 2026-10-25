export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { inList, xcall, xrows } from '@/lib/dealer/rpc';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Installer pay: piece-rate tickets from completions (splits, job minimums, over-measure flags,
 * chargebacks netted) and the chargebacks themselves. A W-2 installer's approved ticket becomes a
 * PIECE time entry (payroll through JOB_TIME); a 1099 installer's is held as a payable request for
 * Merit Books' AP (see the seam note in migration 1122).
 */
export const GET = route({ access: { cap: 'projects.time', action: 'view' }, mask: ['labor_rate', 'time_entry'], query: z.object({ company: Uuid, status: z.enum(['DRAFT', 'FINALIZED', 'APPROVED', 'PAID', 'VOID', 'OPEN']).default('OPEN') }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  let t = pm.from('v_flr_pay_tickets_masked').select('id, job_id, number, worker_type, employee_id, vendor_id, completed_on, split_pct, hours_worked, status, gross_cents, chargeback_cents, net_cents, posting, finalized_at, approved_at, void_reason, created_at').eq('location_id', query.company);
  t = query.status === 'OPEN' ? t.in('status', ['DRAFT', 'FINALIZED']) : t.eq('status', query.status);
  const tickets = await xrows<{ id: string } & Record<string, unknown>>(t.order('completed_on', { ascending: false }).limit(300), 'pay tickets');
  const [lines, chargebacks] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_flr_pay_ticket_lines_masked').select('id, ticket_id, line_no, labor_code, description, unit, qty, rate_cents, amount_cents, measured_qty, over_measured').in('ticket_id', inList(tickets.map((x) => x.id))).order('line_no'), 'pay lines'),
    xrows<Record<string, unknown>>(pm.from('v_flr_chargebacks_masked').select('id, job_id, worker_type, employee_id, vendor_id, reason, description, amount_cents, applied_cents, status, acknowledged_by_name, acknowledged_at, created_at').eq('location_id', query.company).in('status', ['PROPOSED', 'ACKNOWLEDGED']).order('created_at', { ascending: false }), 'chargebacks'),
  ]);
  return { tickets, lines, chargebacks };
});

const Split = z.object({ worker_type: z.enum(['W2', '1099']), employee_id: Uuid.nullish(), vendor_id: Uuid.nullish(), pct: z.number().positive().max(1), hours_worked: z.number().min(0).max(200).nullish() });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('from_completion'), jobId: Uuid, completedOn: IsoDate, lines: z.array(z.object({ labor_code: Req(30, 'The labor code'), qty: z.number().positive().max(1e7) })).min(1).max(100), splits: z.array(Split).min(1).max(10) }),
  z.object({ op: z.literal('finalize'), ticketId: Uuid, hoursWorked: z.number().min(0).max(200).nullish() }),
  z.object({ op: z.literal('approve'), ticketId: Uuid }),
  z.object({ op: z.literal('void'), ticketId: Uuid, reason: Req(300, 'A reason') }),
  z.object({ op: z.literal('propose_chargeback'), companyId: Uuid, workerType: z.enum(['W2', '1099']), workerId: Uuid, reason: z.enum(['CALLBACK', 'DAMAGE', 'MATERIAL_OVERUSE', 'NO_SHOW', 'OTHER']), description: Req(1000, 'What happened'), amountCents: PosCents, jobId: Uuid.nullish() }),
  z.object({ op: z.literal('acknowledge_chargeback'), chargebackId: Uuid, name: Text(120).nullish(), waive: z.boolean().default(false) }),
]);

export const POST = route({
  access: { cap: 'projects.time', action: 'view' },
  // approve: W-2 tickets need time:approve, 1099 tickets commitments or billing approve; the database decides (security review H1).
  ops: { void: { cap: 'projects.time', action: 'approve' } },
  mask: ['labor_rate', 'time_entry'],
  body: Op,
}, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'from_completion': {
      const sum = body.splits.reduce((s, x) => s + Math.round(x.pct * 10000), 0);
      if (sum !== 10000) throw new HttpError(422, 'The installers’ splits must add up to 100%.', 'VALIDATION');
      if (body.splits.some((s) => (s.worker_type === 'W2' ? !s.employee_id : !s.vendor_id))) throw new HttpError(422, 'Each split needs the employee (W-2) or the vendor (1099).', 'VALIDATION');
      return xcall(db, 'flr_ticket_from_completion', { p_job: body.jobId, p_completed_on: body.completedOn, p_lines: body.lines, p_splits: body.splits });
    }
    case 'finalize':
      return { id: await xcall<string>(db, 'flr_finalize_pay_ticket', { p_ticket: body.ticketId, p_hours_worked: body.hoursWorked ?? null }) };
    case 'approve':
      return xcall(db, 'flr_approve_pay_ticket', { p_ticket: body.ticketId });
    case 'void':
      return { id: await xcall<string>(db, 'flr_void_pay_ticket', { p_ticket: body.ticketId, p_reason: body.reason }) };
    case 'propose_chargeback':
      assertCompany(tenant, body.companyId);
      return { id: await xcall<string>(db, 'flr_propose_chargeback', { p_location: body.companyId, p_worker_type: body.workerType, p_worker: body.workerId, p_reason: body.reason, p_description: body.description, p_amount_cents: body.amountCents, p_job: body.jobId ?? null }) };
    case 'acknowledge_chargeback':
      return { id: await xcall<string>(db, 'flr_acknowledge_chargeback', { p_chargeback: body.chargebackId, p_name: body.name ?? null, p_waive: body.waive }) };
  }
});
