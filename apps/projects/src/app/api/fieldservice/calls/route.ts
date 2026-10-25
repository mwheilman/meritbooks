import { z } from 'zod';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Caller = z.object({
  phone: Text(40).nullish(),
  name: Text(120).nullish(),
  email: Text(254).nullish(),
  address: Text(200).nullish(),
}).default({});

const Book = z.object({
  op: z.literal('book'),
  companyId: Uuid,
  channel: z.enum(['PHONE', 'WALK_IN', 'INTERNAL', 'AI_AGENT', 'SMS', 'EMAIL', 'PORTAL', 'LSA', 'ANGI', 'THUMBTACK']).default('PHONE'),
  bookingJobTypeId: Uuid,
  businessUnitId: Uuid.nullish(),
  arrivalWindowId: Uuid,
  serviceDay: Day,
  customerId: Uuid.nullish(),
  siteId: Uuid.nullish(),
  siteZip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Use a 5-digit zip').nullish(),
  zoneId: Uuid.nullish(),
  campaignId: Uuid.nullish(),
  jobId: Uuid.nullish(),
  jobName: Text(120).nullish(),
  summary: Text(500).nullish(),
  priority: z.number().int().min(1).max(5).nullish(),
  tags: z.array(Text(40)).max(12).default([]),
  answers: z.record(z.union([z.string().max(500), z.boolean()])).default({}),
  disclosures: z.array(Text(40)).max(20).default([]),
  assetId: Uuid.nullish(),
  caller: Caller,
  overrideReason: Text(300).nullish(),
  allowDuplicate: z.boolean().default(false),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
});

const Log = z.object({
  op: z.literal('log'),
  companyId: Uuid,
  channel: z.enum(['PHONE', 'WALK_IN', 'INTERNAL', 'AI_AGENT', 'SMS', 'EMAIL', 'PORTAL', 'LSA', 'ANGI', 'THUMBTACK']).default('PHONE'),
  outcome: z.enum(['NOT_BOOKED', 'CANCELLED', 'OPEN']),
  reason: Need(300, 'Say why the call did not book').nullish(),
  customerId: Uuid.nullish(),
  caller: Caller,
  campaignId: Uuid.nullish(),
  businessUnitId: Uuid.nullish(),
  bookingJobTypeId: Uuid.nullish(),
  summary: Text(500).nullish(),
});

const Body = z.discriminatedUnion('op', [Book, Log]);

/**
 * Book a call into capacity (FS-02/03/15) or log a call that did not book. The database enforces
 * capacity, the duplicate-job rule and do-not-service; this route only shapes the request.
 */
export const POST = route(
  { access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body },
  async ({ db, body, userId }) => {
    if (body.op === 'log') {
      const id = await fsCall<string>(db, 'fs_log_call', {
        p_location: body.companyId, p_channel: body.channel, p_outcome: body.outcome, p_reason: body.reason ?? null,
        p_customer: body.customerId ?? null, p_caller: body.caller, p_campaign: body.campaignId ?? null,
        p_business_unit: body.businessUnitId ?? null, p_summary: body.summary || null, p_booking_job_type: body.bookingJobTypeId ?? null,
      });
      return { callId: id };
    }
    const r = await fsCall<{ call_id: string; call_number: string | null; status: string; job_id: string | null; work_order_id: string | null; work_order_number: string | null; override: boolean }>(
      db, 'fs_book_call', {
        p_location: body.companyId, p_channel: body.channel, p_booking_job_type: body.bookingJobTypeId,
        p_arrival_window: body.arrivalWindowId, p_service_day: body.serviceDay, p_business_unit: body.businessUnitId ?? null,
        p_customer: body.customerId ?? null, p_site: body.siteId ?? null, p_site_zip: body.siteZip ?? null, p_zone: body.zoneId ?? null,
        p_campaign: body.campaignId ?? null, p_job: body.jobId ?? null, p_job_name: body.jobName || null, p_summary: body.summary || null,
        p_priority: body.priority ?? null, p_tags: body.tags, p_answers: body.answers, p_disclosures: body.disclosures,
        p_asset: body.assetId ?? null, p_caller: body.caller, p_override_reason: body.overrideReason || null,
        p_allow_duplicate: body.allowDuplicate, p_source_ref: body.requestId ? `csr:${userId}:${body.requestId}` : null,
      });
    return {
      callId: r.call_id, callNumber: r.call_number, status: r.status, jobId: r.job_id, workOrderId: r.work_order_id,
      workOrderNumber: r.work_order_number, override: r.override,
    };
  },
);
