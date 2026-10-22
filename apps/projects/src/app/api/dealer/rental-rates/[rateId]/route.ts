export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { downs, dwrite } from '@/lib/pm/dealer/rpc';
import { Text } from '@/lib/pm/dealer/schemas';

const Rate = z.number().int().min(0).max(1e10).nullish();

const Body = z.object({
  label: Text(80).nullish(),
  dayCents: Rate,
  weekCents: Rate,
  monthCents: Rate,
  damageWaiverPct: z.number().min(0).max(1).nullish(),
  isActive: z.boolean().optional(),
});

/** Change or retire a rental rate. Contracts keep the rate they were reserved at. */
export const POST = route({ body: Body }, async ({ db, params, body, tenant }) => {
  const r = await downs<{ id: string; location_id: string; day_cents: number | null; week_cents: number | null; month_cents: number | null }>(db, 'rental_rates', 'id, location_id, day_cents, week_cents, month_cents', params.rateId!, 'That rate was not found.');
  assertCompany(tenant, r.location_id);
  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) patch.label = body.label || null;
  if (body.dayCents !== undefined) patch.day_cents = body.dayCents || null;
  if (body.weekCents !== undefined) patch.week_cents = body.weekCents || null;
  if (body.monthCents !== undefined) patch.month_cents = body.monthCents || null;
  if (body.damageWaiverPct !== undefined) patch.damage_waiver_pct = body.damageWaiverPct;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  const day = 'day_cents' in patch ? patch.day_cents : r.day_cents;
  const week = 'week_cents' in patch ? patch.week_cents : r.week_cents;
  const month = 'month_cents' in patch ? patch.month_cents : r.month_cents;
  if (!Number(day ?? 0) && !Number(week ?? 0) && !Number(month ?? 0)) throw new HttpError(422, 'A rate needs a day, week or month price.', 'VALIDATION');
  await dwrite(db.schema('pm').from('rental_rates').update(patch).eq('id', r.id).select('id'), 'update rental rate');
  return { ok: true };
});
