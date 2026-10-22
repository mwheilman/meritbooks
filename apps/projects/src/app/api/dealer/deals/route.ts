export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall, dwrite } from '@/lib/pm/dealer/rpc';
import { FinanceZ, Rate, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Body = z.object({
  companyId: Uuid,
  customerId: Uuid.nullish(),
  financeType: FinanceZ.default('CASH'),
  taxRateEstimate: Rate.nullish(),
  taxExempt: z.boolean().default(false),
  notes: Text(2000).nullish(),
  /** Start the desk with this unit on it. */
  unitId: Uuid.nullish(),
});

/** Start a deal (pm.create_deal: number, the company's delivery checklist and tax estimate). */
export const POST = route({ access: { cap: 'projects.store', action: 'create' }, mask: 'dealer_deal', body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const id = await dcall<string | null>(db, 'create_deal', {
    p_location: body.companyId,
    p_customer: body.customerId ?? null,
    p_attrs: attrs({ finance_type: body.financeType, tax_rate_estimate: body.taxRateEstimate, tax_exempt: body.taxExempt || undefined, notes: body.notes }),
  });
  if (!id) throw new HttpError(500, 'The deal was not started. Try again.', 'CREATE_FAILED');
  if (body.unitId) {
    await dwrite(db.schema('pm').from('dealer_deal_lines').insert({ deal_id: id, line_type: 'UNIT', asset_id: body.unitId, qty: 1, line_no: 1, sort: 0 }).select('id'), 'add the unit');
  }
  const row = await db.schema('pm').from('dealer_deals').select('number').eq('id', id).maybeSingle();
  return { dealId: id, number: (row.data as { number: string } | null)?.number ?? null };
});
