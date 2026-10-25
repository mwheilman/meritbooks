import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { decideObject } from '@/lib/approvals/server';
import { fsCall } from '@/lib/fieldservice/rpc';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { ReviewRow } from '@/lib/fieldservice/completion-types';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Invoice review queue (FS-94) and text-to-pay (FS-96). GET ?companyId= — completed visits waiting
 * for review with their rule flags (totals only for contract-value holders, stripped in the DB).
 * POST: refresh the flags after a fix; approve (→ a DRAFT billing request, sent on through the 1113
 * approval engine so Books mints the invoice — blocking flags need a billing approver's reason) or
 * return to the tech; text the Books pay link once the invoice is issued (no amount in the text).
 */
export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: z.object({ companyId: Uuid }) }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const r = await rpcLoad<ReviewRow[]>(db, 'fs_review_queue', { p_location: query.companyId }, []);
  return { reviews: r.data, error: r.error };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('refresh'), reviewId: Uuid }),
  z.object({ op: z.literal('approve'), reviewId: Uuid, overrideReason: Text(500).nullish(), submit: z.boolean().default(true) }),
  z.object({ op: z.literal('return'), reviewId: Uuid, reason: z.string().trim().min(3, 'Say what needs fixing').max(1000) }),
  z.object({ op: z.literal('pay_link'), reviewId: Uuid, channel: z.enum(['SMS', 'EMAIL']).default('SMS'), contactId: Uuid.nullish() }),
]);

export const POST = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'refresh':
      return fsCall(db, 'fs_refresh_review', { p_review: body.reviewId });
    case 'approve': {
      const r = await fsCall<{ status: string; billing_request_id: string | null; lines: number }>(db, 'fs_decide_review', {
        p_review: body.reviewId, p_decision: 'APPROVE', p_reason: null, p_override_reason: body.overrideReason ?? null });
      const approval = body.submit && r.billing_request_id ? await decideObject(db, 'billing_request', r.billing_request_id).catch(() => null) : null;
      return { ...r, approval: approval ? { status: approval.status, requestId: approval.request_id ?? null, waitingOn: approval.waiting_on ?? null } : null };
    }
    case 'return':
      return fsCall(db, 'fs_decide_review', { p_review: body.reviewId, p_decision: 'RETURN', p_reason: body.reason, p_override_reason: null });
    case 'pay_link':
      return fsCall(db, 'fs_text_to_pay', { p_review: body.reviewId, p_billing_request: null, p_channel: body.channel, p_contact: body.contactId ?? null,
        p_command: null });
  }
});
