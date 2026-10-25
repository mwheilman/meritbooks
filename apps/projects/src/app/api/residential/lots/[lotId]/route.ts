export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { loadLot } from '@/lib/residential/queries';
import { resRpc } from '@/lib/residential/rpc';
import type { LotQuote } from '@/lib/residential/types';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['dev_unit', 'estimate', 'commitment'] }, async ({ db, params }) => loadLot(db, params.lotId!));

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('quote'), planId: Uuid, elevationId: Uuid.nullish(), optionIds: z.array(Uuid).max(200).default([]) }),
  z.object({ op: z.literal('agreement'), customerId: Uuid, planId: Uuid, elevationId: Uuid.nullish(), optionIds: z.array(Uuid).max(200).default([]),
    earnestMoneyCents: Cents.default(0), earnestInEscrow: z.boolean().default(true), incentivesCents: Cents.nullish(),
    contingencies: z.array(z.object({ kind: z.enum(['FINANCING', 'APPRAISAL', 'SALE_OF_HOME', 'INSPECTION', 'OTHER']), dueOn: Day.nullish() })).max(10).default([]) }),
  z.object({ op: z.literal('sign'), agreementId: Uuid, signerName: Text(200).min(1, 'Buyer name'), jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish() }),
  z.object({ op: z.literal('options'), agreementId: Uuid, add: z.array(Uuid).max(100).default([]), remove: z.array(Uuid).max(100).default([]), signerName: Text(200).nullish() }),
  z.object({ op: z.literal('sign_addendum'), addendumId: Uuid, signerName: Text(200).min(1) }),
  z.object({ op: z.literal('release'), startOn: Day.nullish(), jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).nullish() }),
  z.object({ op: z.literal('release_stage'), stage: z.enum(['START', 'FOUNDATION', 'FRAME', 'MECHANICAL', 'DRYWALL', 'TRIM', 'FINAL']) }),
  z.object({ op: z.literal('preview_package') }),
]);

const OPS = {
  release: { cap: 'projects.commitments', action: 'create' }, release_stage: { cap: 'projects.commitments', action: 'edit' }, preview_package: { cap: 'projects.commitments', action: 'view' },
} as const;

/** Lot → quote → purchase agreement → design-center addenda → release (start package) → stage releases. */
export const POST = route({ access: { cap: 'projects.estimates', action: 'view' }, ops: OPS, mask: ['dev_unit', 'estimate', 'commitment'], body: Op }, async ({ db, params, body }) => {
  const lot = params.lotId!;
  switch (body.op) {
    case 'quote': return resRpc<LotQuote>(db, 'res_quote_lot', { p_lot: lot, p_plan: body.planId, p_elevation: body.elevationId ?? null, p_options: body.optionIds, p_on: null });
    case 'agreement':
      return { agreementId: await resRpc<string>(db, 'res_create_purchase_agreement', { p_lot: lot, p_customer: body.customerId, p_plan: body.planId, p_elevation: body.elevationId ?? null,
        p_options: body.optionIds, p_attrs: { earnest_money_cents: body.earnestMoneyCents, earnest_in_escrow: body.earnestInEscrow, incentives_cents: body.incentivesCents ?? undefined,
          contingencies: body.contingencies.map((c) => ({ kind: c.kind, due_on: c.dueOn ?? null, status: 'OPEN' })) } }) };
    case 'sign': return resRpc(db, 'res_sign_purchase_agreement', { p_pa: body.agreementId, p_signer_name: body.signerName, p_job_type_key: body.jobTypeKey ?? null });
    case 'options': return resRpc(db, 'res_pa_change_options', { p_pa: body.agreementId, p_add: body.add, p_remove: body.remove, p_signer_name: body.signerName ?? null });
    case 'sign_addendum': return resRpc(db, 'res_sign_addendum', { p_addendum: body.addendumId, p_signer_name: body.signerName });
    case 'release': return resRpc(db, 'res_release_lot', { p_lot: lot, p_start_on: body.startOn ?? null, p_job_type_key: body.jobTypeKey ?? null });
    case 'release_stage': return { released: await resRpc<unknown[]>(db, 'res_release_stage', { p_lot: lot, p_stage: body.stage }) };
    case 'preview_package': return resRpc(db, 'res_preview_start_package', { p_lot: lot });
  }
});
