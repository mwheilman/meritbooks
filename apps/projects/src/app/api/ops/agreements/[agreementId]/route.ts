import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Cents, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('activate') }),
  z.object({ op: z.literal('generate'), horizonDays: z.number().int().min(0).max(1830).default(365) }),
  z.object({ op: z.literal('renew'), priceCents: Cents.nullish() }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish(), cancelOpenVisits: z.boolean().default(true) }),
  z.object({ op: z.literal('update'), planName: Need(120, 'Name the plan').optional(), visitWindowDays: z.number().int().min(1).max(366).optional(), visitMinutes: z.number().int().min(1).max(1440).optional(), autoRenew: z.boolean().optional() }),
  z.object({ op: z.literal('cover'), assetId: Uuid }),
  z.object({ op: z.literal('uncover'), assetId: Uuid }),
  z.object({ op: z.literal('delete') }),
]);

export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const a = await own<{ id: string; location_id: string; status: string }>(db, 'service_agreements', 'id, location_id, status', { id: params.agreementId! }, 'That agreement was not found.');
  assertCompany(tenant, a.location_id);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'activate':
      await call(db, 'activate_agreement', { p_agreement: a.id });
      return { ok: true };
    case 'generate': {
      const n = await call<number>(db, 'generate_agreement_visits', { p_agreement: a.id, p_horizon_days: body.horizonDays });
      return { ok: true, created: n };
    }
    case 'renew': {
      const id = await call<string>(db, 'renew_agreement', { p_agreement: a.id, p_price_cents: body.priceCents ?? null });
      return { ok: true, agreementId: id };
    }
    case 'cancel':
      await call(db, 'cancel_agreement', { p_agreement: a.id, p_reason: body.reason || null, p_cancel_open_visits: body.cancelOpenVisits });
      return { ok: true };
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.planName !== undefined) patch.plan_name = body.planName;
      if (body.visitWindowDays !== undefined) patch.visit_window_days = body.visitWindowDays;
      if (body.visitMinutes !== undefined) patch.visit_minutes = body.visitMinutes;
      if (body.autoRenew !== undefined) patch.auto_renew = body.autoRenew;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('service_agreements').update(patch).eq('id', a.id).select('id'), 'update agreement');
      return { ok: true };
    }
    case 'cover':
      await write(pm.from('agreement_assets').upsert({ agreement_id: a.id, asset_id: body.assetId }, { onConflict: 'agreement_id,asset_id' }).select('asset_id'), 'cover equipment');
      return { ok: true };
    case 'uncover':
      await write(pm.from('agreement_assets').delete().eq('agreement_id', a.id).eq('asset_id', body.assetId).select('asset_id'), 'remove equipment');
      return { ok: true };
    case 'delete': {
      if (a.status !== 'DRAFT') throw new HttpError(422, 'Only a draft agreement can be deleted. Cancel an active one instead.', 'VALIDATION');
      await write(pm.from('service_agreements').delete().eq('id', a.id).select('id'), 'delete agreement');
      return { ok: true };
    }
  }
});
