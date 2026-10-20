import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { own, write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  workOrderId: Uuid,
  payerCustomerId: Uuid,
  claimNumber: Text(60).nullish(),
  failureCode: Text(60).nullish(),
  laborOp: Text(60).nullish(),
  claimedLaborCents: Cents.default(0),
  claimedPartsCents: Cents.default(0),
  claimedOtherCents: Cents.default(0),
  filingDeadline: Day.nullish(),
  notes: Text(2000).nullish(),
});

/** A draft warranty claim on a repair order (the OEM as the AR party Books bills). */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  const wo = await own<{ id: string; job_id: string; location_id: string; asset_id: string | null }>(db, 'work_orders', 'id, job_id, location_id, asset_id', { id: body.workOrderId }, 'That repair order was not found.');
  assertCompany(tenant, wo.location_id);
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('warranty_claims').insert({
      job_id: wo.job_id, work_order_id: wo.id, asset_id: wo.asset_id, payer_customer_id: body.payerCustomerId, claim_number: body.claimNumber || null,
      failure_code: body.failureCode || null, labor_op: body.laborOp || null, claimed_labor_cents: body.claimedLaborCents,
      claimed_parts_cents: body.claimedPartsCents, claimed_other_cents: body.claimedOtherCents, filing_deadline: body.filingDeadline ?? null, notes: body.notes || null,
    }).select('id'),
    'add warranty claim',
  );
  if (!r[0]) throw new HttpError(500, 'The claim was not saved. Try again.', 'CREATE_FAILED');
  return { claimId: r[0].id };
});
