export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dcall } from '@/lib/pm/dealer/rpc';
import { Rate, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Body = z.object({
  companyId: Uuid,
  customerId: Uuid.nullish(),
  stockLocationId: Uuid.nullish(),
  poNumber: Text(40).nullish(),
  taxExempt: z.boolean().optional(),
  taxExemptRef: Text(60).nullish(),
  taxRateEstimate: Rate.nullish(),
});

/** Open a counter ticket (pm.open_parts_ticket: number, stock location, tax estimate from store settings). */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const id = await dcall<string | null>(db, 'open_parts_ticket', {
    p_location: body.companyId, p_customer: body.customerId ?? null, p_stock_location: body.stockLocationId ?? null,
    p_attrs: attrs({ po_number: body.poNumber, tax_exempt: body.taxExempt, tax_exempt_ref: body.taxExemptRef, tax_rate_estimate: body.taxRateEstimate }),
  });
  if (!id) throw new HttpError(500, 'The ticket was not opened. Try again.', 'CREATE_FAILED');
  const row = await db.schema('pm').from('parts_tickets').select('number').eq('id', id).maybeSingle();
  return { ticketId: id, number: (row.data as { number: string } | null)?.number ?? null };
});
