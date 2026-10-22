export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { Text, Uuid } from '@/lib/pm/dealer/schemas';

const Rate = z.number().int().min(0).max(1e10).nullish();

const RateBody = z.object({
  companyId: Uuid,
  /** Scope: one unit, a model, a category, or (all empty) the company default. */
  assetId: Uuid.nullish(),
  model: Text(80).nullish(),
  category: Text(40).nullish(),
  label: Text(80).nullish(),
  dayCents: Rate,
  weekCents: Rate,
  monthCents: Rate,
  damageWaiverPct: z.number().min(0).max(1).nullish(),
}).refine((b) => (b.dayCents ?? 0) + (b.weekCents ?? 0) + (b.monthCents ?? 0) > 0, { message: 'Give a day, week or month rate', path: ['dayCents'] });

/** Add a rental rate (pm.rental_rates; one active rate per scope). */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'rental', body: RateBody }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const r = await dwrite<Array<{ id: string }>>(db.schema('pm').from('rental_rates').insert({
    location_id: body.companyId, asset_id: body.assetId ?? null, model: body.model || null, category: body.category || null, label: body.label || null,
    day_cents: body.dayCents || null, week_cents: body.weekCents || null, month_cents: body.monthCents || null, damage_waiver_pct: body.damageWaiverPct ?? null, is_active: true,
  }).select('id'), 'add rental rate');
  if (!r[0]) throw new HttpError(500, 'The rate was not saved. Try again.', 'CREATE_FAILED');
  return { rateId: r[0].id };
});
