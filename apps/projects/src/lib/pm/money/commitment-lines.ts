/** Commitment line input → row (amount = qty × unit cost with the trigger's rounding). Pure. */
import { z } from 'zod';
import { extendCents } from './aia';
import { PosCents, Qty, Text200, Uuid } from './schemas';

export const CommitmentLineSchema = z.object({
  costCodeId: Uuid.nullish(),
  description: Text200.default(''),
  qty: Qty.nullish(),
  uom: z.string().trim().max(16).nullish(),
  unitCostCents: PosCents.nullish(),
  amountCents: PosCents.nullish(),
});

export type CommitmentLineInput = z.infer<typeof CommitmentLineSchema>;

export function commitmentLineRow(l: CommitmentLineInput) {
  const amount = l.qty && l.unitCostCents != null ? extendCents(l.qty, l.unitCostCents) : l.amountCents ?? 0;
  return {
    cost_code_id: l.costCodeId ?? null, description: l.description ?? '', qty: l.qty ?? null, uom: l.uom ?? null,
    unit_cost_cents: l.unitCostCents ?? null, amount_cents: amount,
  };
}
