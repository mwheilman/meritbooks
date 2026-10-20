import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { call } from '@/lib/pm/ops/rpc';
import { resolveJob } from '@/lib/pm/ops/jobs';
import { Instant, Day, NewJobZ, Need, PayerZ, SkillCode, Text, Uuid, WoKindZ } from '@/lib/pm/ops/schemas';

const Body = z
  .object({
    jobId: Uuid.nullish(),
    newJob: NewJobZ.nullish(),
    kind: WoKindZ,
    summary: Need(200, 'Say what the work is'),
    priority: z.number().int().min(1).max(5).default(3),
    assetId: Uuid.nullish(),
    complaint: Text(2000).nullish(),
    requestedStart: Instant.nullish(),
    requestedEnd: Instant.nullish(),
    estimatedMinutes: z.number().int().min(0).max(14_400).nullish(),
    requiredSkills: z.array(SkillCode).max(12).default([]),
    payerType: PayerZ.default('CUSTOMER'),
    payerCustomerId: Uuid.nullish(),
    promisedOn: Day.nullish(),
    isCallback: z.boolean().default(false),
  })
  .refine((b) => b.kind !== 'REPAIR_ORDER' || !!b.assetId, { message: 'A repair order needs the unit (serial) it is for', path: ['assetId'] })
  .refine((b) => (b.payerType !== 'OEM' && b.payerType !== 'THIRD_PARTY') || !!b.payerCustomerId, { message: 'Pick who pays (the manufacturer or third party)', path: ['payerCustomerId'] })
  .refine((b) => !b.requestedStart || !b.requestedEnd || b.requestedEnd > b.requestedStart, { message: 'The window ends before it starts', path: ['requestedEnd'] });

/** Create a work order (and, Jobber-style, its job in the same step). pm.create_work_order mints the number. */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  const job = await resolveJob(db, tenant, body.jobId, body.newJob);
  const id = await call<string | null>(db, 'create_work_order', {
    p_job: job.job_id,
    p_kind: body.kind,
    p_summary: body.summary,
    p_priority: body.priority,
    p_asset: body.assetId ?? null,
    p_requested_start: body.requestedStart ?? null,
    p_requested_end: body.requestedEnd ?? null,
    p_estimated_minutes: body.estimatedMinutes ?? null,
    p_required_skills: body.requiredSkills,
    p_payer_type: body.payerType,
    p_payer_customer: body.payerCustomerId ?? null,
    p_is_callback: body.isCallback,
    p_callback_of: null,
    p_complaint: body.complaint || null,
    p_ext: {},
    p_promised_on: body.promisedOn ?? null,
  });
  if (!id) throw new HttpError(500, 'The work order was not created. Try again.', 'CREATE_FAILED');
  const row = await db.schema('pm').from('work_orders').select('number').eq('id', id).maybeSingle();
  return { workOrderId: id, jobId: job.job_id, number: (row.data as { number: string | null } | null)?.number ?? null };
});
