export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { listLaborRates } from '@/lib/pm/labor/queries';
import { laborCall } from '@/lib/pm/labor/rpc';
import { NewRateCardBody, cardKeyFrom } from '@/lib/pm/labor/schemas';

export const GET = route({ query: z.object({ companyId: z.string().uuid() }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  return { rates: await listLaborRates(db, query.companyId) };
});

/** Add a labor rate card (pm.save_labor_rate_card). Blank burden / overhead inherit the company default. */
export const POST = route({ body: NewRateCardBody }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const id = await laborCall<string>(db, 'save_labor_rate_card', {
    p_location: body.companyId,
    p_key: body.key || cardKeyFrom(body.label),
    p_label: body.label,
    p_base_rate_cents: body.baseRateCents ?? null,
    p_burden_pct: body.burdenPct ?? null,
    p_overhead_pct: body.overheadPct ?? null,
    p_bill_rate_cents: body.billRateCents ?? null,
    p_effective_from: body.effectiveFrom ?? null,
    p_id: null,
    p_is_active: true,
  });
  return { rateCardId: id };
});
