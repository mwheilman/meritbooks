import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('convert'), customerId: Uuid.nullish(), siteId: Uuid.nullish(), jobId: Uuid.nullish(), jobName: Text(120).nullish(), allowDuplicate: z.boolean().default(false) }),
  z.object({ op: z.literal('close'), status: z.enum(['NOT_BOOKED', 'CANCELLED']), reason: Text(300).nullish() }),
]);

/** Requests inbox (FS-10): convert a held web request into a job in the same slot, or decline it. */
export const POST = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body }, async ({ db, params, body, tenant }) => {
  const c = await fsOwn<{ id: string; location_id: string }>(db, 'service_calls', 'id, location_id', params.callId!, 'That call was not found.');
  assertCompany(tenant, c.location_id);
  if (body.op === 'convert') {
    const r = await fsCall<{ work_order_id: string; job_id: string; work_order_number: string | null }>(db, 'fs_convert_request', {
      p_call: c.id, p_customer: body.customerId ?? null, p_site: body.siteId ?? null, p_job: body.jobId ?? null, p_job_name: body.jobName || null,
      p_allow_duplicate: body.allowDuplicate,
    });
    return { workOrderId: r.work_order_id, jobId: r.job_id, workOrderNumber: r.work_order_number };
  }
  await fsCall(db, 'fs_close_call', { p_call: c.id, p_status: body.status, p_reason: body.reason || null });
  return { ok: true };
});
