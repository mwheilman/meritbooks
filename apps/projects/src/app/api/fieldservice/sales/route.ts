import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { loadPendingAcceptances, rpcLoad } from '@/lib/fieldservice/completion';
import type { FollowupQueueRow, Pipeline } from '@/lib/fieldservice/completion-types';
import { Cents, Instant, Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Selling after the visit: the comfort-advisor pipeline (FS-57), the unsold-estimate follow-up
 * queue (FS-56) and estimates the customer accepted online (FS-59). Sell prices only; the sold
 * value per advisor needs contract value (stripped in the DB).
 */
export const GET = route({ access: { cap: 'projects.leads', action: 'view' }, mask: false, query: z.object({ companyId: Uuid }) }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const [pipeline, queue, accepted] = await Promise.all([
    rpcLoad<Pipeline>(db, 'fs_advisor_pipeline', { p_location: query.companyId, p_from: null, p_to: null }, { by_advisor: [], by_source: [], open: [] }),
    rpcLoad<FollowupQueueRow[]>(db, 'fs_followup_queue', { p_location: query.companyId }, []),
    loadPendingAcceptances(db, query.companyId),
  ]);
  return { pipeline: pipeline.data, queue: queue.data, accepted: accepted.data, error: pipeline.error ?? queue.error ?? accepted.error };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), companyId: Uuid, customerId: Uuid.nullish(), title: z.string().trim().min(1).max(200),
             source: z.enum(['MARKETING', 'CALL', 'WEB', 'REFERRAL', 'AGREEMENT', 'OTHER']).default('MARKETING'), campaignId: Uuid.nullish(),
             advisorId: Uuid.nullish(), appointmentAt: Instant.nullish(), jobId: Uuid.nullish() }),
  z.object({ op: z.literal('advance'), opportunityId: Uuid, stage: z.enum(['LEAD', 'APPOINTMENT', 'PROPOSAL', 'LOST']), reason: Text(500).nullish(),
             appointmentAt: Instant.nullish(), advisorId: Uuid.nullish(), estimateId: Uuid.nullish() }),
  z.object({ op: z.literal('followup_done'), followupId: Uuid, outcome: Text(500).nullish(), skip: z.boolean().default(false) }),
  z.object({ op: z.literal('run'), companyId: Uuid }),
  z.object({ op: z.literal('finalize'), acceptanceId: Uuid, depositCents: Cents.default(0), requestDeposit: z.boolean().default(false), financingPlanId: Uuid.nullish() }),
  z.object({ op: z.literal('reject'), acceptanceId: Uuid, reason: z.string().trim().min(3).max(500) }),
]);

export const POST = route({ access: { cap: 'projects.leads', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'open':
      return { id: await fsCall<string>(db, 'fs_open_opportunity', { p_location: body.companyId, p_customer: body.customerId ?? null, p_title: body.title, p_source: body.source,
        p_campaign: body.campaignId ?? null, p_advisor: body.advisorId ?? null, p_appointment_at: body.appointmentAt ?? null, p_job: body.jobId ?? null, p_site: null, p_business_unit: null }) };
    case 'advance':
      return { id: await fsCall<string>(db, 'fs_advance_opportunity', { p_opportunity: body.opportunityId, p_stage: body.stage, p_reason: body.reason ?? null,
        p_appointment_at: body.appointmentAt ?? null, p_advisor: body.advisorId ?? null, p_estimate: body.estimateId ?? null }) };
    case 'followup_done':
      return { id: await fsCall<string>(db, 'fs_complete_followup', { p_followup: body.followupId, p_outcome: body.outcome ?? null, p_status: body.skip ? 'SKIPPED' : 'DONE' }) };
    case 'run':
      return fsCall(db, 'fs_run_automations', { p_location: body.companyId });
    case 'finalize':
      return fsCall(db, 'fs_finalize_online_acceptance', { p_acceptance: body.acceptanceId, p_deposit_cents: body.depositCents, p_request_deposit: body.requestDeposit,
        p_financing_plan: body.financingPlanId ?? null });
    case 'reject':
      return { id: await fsCall<string>(db, 'fs_reject_online_acceptance', { p_acceptance: body.acceptanceId, p_reason: body.reason }) };
  }
});
