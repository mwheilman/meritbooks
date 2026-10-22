export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { counterSearch } from '@/lib/pm/dealer/parts-queries';
import { dcall } from '@/lib/pm/dealer/rpc';
import { Cents, PartNumber, Text, Uuid, attrs } from '@/lib/pm/dealer/schemas';

const Query = z.object({ companyId: z.string().uuid(), pn: z.string().max(40).default('') });

/**
 * Counter lookup: the keyed number's matches, each followed through supersession to the number the
 * ticket sells, with on-hand by bin; prefix suggestions when nothing matches exactly.
 */
export const GET = route({ query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  return counterSearch(db, query.companyId, query.pn);
});

const Body = z.object({
  companyId: Uuid,
  partNumber: PartNumber,
  description: Text(200).nullish(),
  manufacturer: Text(24).nullish(),
  mfrVendorId: Uuid.nullish(),
  uom: Text(12).nullish(),
  category: Text(40).nullish(),
  costCents: Cents.nullish(),
  listPriceCents: Cents.nullish(),
  priceCents: Cents.nullish(),
  coreChargeCents: Cents.nullish(),
});

/** Add a part, or update it when the number is already in the catalog (pm.upsert_part; a new part gets its core.items identity). */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const id = await dcall<string | null>(db, 'upsert_part', {
    p_location: body.companyId, p_part_number: body.partNumber, p_description: body.description || null,
    p_attrs: attrs({
      manufacturer: body.manufacturer, mfr_vendor_id: body.mfrVendorId, uom: body.uom, category: body.category, cost_cents: body.costCents,
      list_price_cents: body.listPriceCents, price_cents: body.priceCents, core_charge_cents: body.coreChargeCents,
    }),
  });
  if (!id) throw new HttpError(500, 'The part was not saved. Try again.', 'CREATE_FAILED');
  return { partId: id };
});
