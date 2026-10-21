import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const PayTypeZ = z.enum(['REG', 'OT', 'DT', 'PIECE', 'FLAG']);

const Body = z.object({
  jobId: Uuid,
  employeeId: Uuid.nullish(),
  workDate: Day,
  hours: z.number().gt(0, 'Hours must be more than 0').max(24, 'At most 24 hours in a day'),
  payType: PayTypeZ.default('REG'),
  costCodeId: Uuid.nullish(),
  workOrderId: Uuid.nullish(),
  operationId: Uuid.nullish(),
  billable: z.boolean().default(true),
  notes: Text(1000).nullish(),
  submit: z.boolean().default(false),
});

/**
 * Time against a job (and a cost code, work order or shop operation). Entries are DRAFT or
 * SUBMITTED; someone other than the preparer approves them (POST /api/ops/time/approve), which
 * pins the cost rate (pay + burden) and sends the hours to Merit Books.
 */
export const POST = route({ body: Body }, async ({ db, body, tenant, userId }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('time_entries').insert({
      job_id: job.job_id, employee_id: body.employeeId ?? null, user_id: body.employeeId ? null : userId, work_date: body.workDate, hours: body.hours,
      pay_type: body.payType, cost_code_id: body.costCodeId ?? null, work_order_id: body.workOrderId ?? null, operation_id: body.operationId ?? null,
      billable: body.billable, notes: body.notes || null, approval_state: body.submit ? 'SUBMITTED' : 'DRAFT',
    }).select('id'),
    'add time',
  );
  if (!r[0]) throw new HttpError(500, 'The time was not saved. Try again.', 'CREATE_FAILED');
  return { entryId: r[0].id };
});
