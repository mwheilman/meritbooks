export const dynamic = 'force-dynamic';

import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { laborCall } from '@/lib/pm/labor/rpc';
import { EditRateCardBody } from '@/lib/pm/labor/schemas';

/** Edit or (de)activate a rate card. Approved time keeps the rate it was approved at. */
export const PATCH = route({ body: EditRateCardBody }, async ({ db, params, body, tenant }) => {
  const card = one<{ id: string; location_id: string; key: string }>(
    await pm(db).from('labor_rate_cards').select('id, location_id, key').eq('id', params.cardId!).maybeSingle(), 'rate card');
  if (!card) throw new HttpError(404, 'That rate card was not found.', 'NOT_FOUND');
  assertCompany(tenant, card.location_id);
  await laborCall(db, 'save_labor_rate_card', {
    p_location: card.location_id,
    p_key: body.key || card.key,
    p_label: body.label,
    p_base_rate_cents: body.baseRateCents ?? null,
    p_burden_pct: body.burdenPct ?? null,
    p_overhead_pct: body.overheadPct ?? null,
    p_bill_rate_cents: body.billRateCents ?? null,
    p_effective_from: body.effectiveFrom ?? null,
    p_id: card.id,
    p_is_active: body.isActive,
  });
  return { ok: true };
});
