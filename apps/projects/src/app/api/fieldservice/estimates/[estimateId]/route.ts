import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import { Cents, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('present') }),
  z.object({ op: z.literal('toggle'), itemId: Uuid, selected: z.boolean() }),
  z.object({
    op: z.literal('sell'),
    optionIds: z.array(Uuid).min(1).max(5),
    signedName: Need(120, 'The customer signs with their name'),
    dismissReason: Text(200).nullish(),
    joinTemplateId: Uuid.nullish(),
    depositCents: Cents.default(0),
    requestDeposit: z.boolean().default(false),
    depositRef: Text(120).nullish(),
    financingPlanId: Uuid.nullish(),
    signatureDocumentId: Uuid.nullish(),
  }),
  z.object({ op: z.literal('decline'), reason: Need(300, 'Say why the customer declined') }),
]);

/**
 * Kitchen-table close (FS-33/34/53): present, tick add-ons, sign (sold option → APPROVED work-order
 * lines at the member price when it applies; others dismissed with the reason), join a membership
 * on site, and optionally request the deposit from Books (needs projects.billing:create).
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, params, body, tenant }) => {
  const e = await fsOwn<{ id: string; location_id: string }>(db, 'fs_estimates', 'id, location_id', params.estimateId!, 'Those options were not found.');
  assertCompany(tenant, e.location_id);
  switch (body.op) {
    case 'present':
      await fsCall(db, 'fs_present_estimate', { p_estimate: e.id });
      return { ok: true };
    case 'toggle':
      await fsCall(db, 'fs_toggle_option_item', { p_item: body.itemId, p_selected: body.selected });
      return { ok: true };
    case 'decline':
      await fsCall(db, 'fs_decline_estimate', { p_estimate: e.id, p_reason: body.reason });
      return { ok: true };
    case 'sell': {
      const r = await fsCall<{ lines: number; agreement_id: string | null; deposit_request_id: string | null; member_pricing: boolean }>(db, 'fs_sell_estimate', {
        p_estimate: e.id, p_option_ids: body.optionIds, p_signed_name: body.signedName, p_dismiss_reason: body.dismissReason || null,
        p_join_template: body.joinTemplateId ?? null, p_deposit_cents: body.depositCents, p_request_deposit: body.requestDeposit,
        p_deposit_ref: body.depositRef || null, p_financing_plan: body.financingPlanId ?? null, p_sold_by_employee: null,
        p_signature_document: body.signatureDocumentId ?? null,
      });
      return { lines: r.lines, agreementId: r.agreement_id, depositRequestId: r.deposit_request_id, memberPricing: r.member_pricing };
    }
  }
});
