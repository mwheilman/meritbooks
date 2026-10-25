import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsWrite } from '@/lib/fieldservice/rpc';
import { Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), companyId: Uuid, name: Text(80).min(1), campaignId: Uuid.nullish(), jobTypeKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)).max(20).default([]), daysAhead: z.number().int().min(1).max(60).default(14), minLeadHours: z.number().int().min(0).max(168).default(2) }),
  z.object({ op: z.literal('disable'), id: Uuid }),
]);

/**
 * Online booking links (FS-09). The clear token is returned once and never stored — only its
 * SHA-256. Settings configure at the company (the database refuses otherwise).
 */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  if (body.op === 'create') {
    assertCompany(tenant, body.companyId);
    const token = randomBytes(24).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await fsWrite<Array<{ id: string }>>(pm.from('booking_widgets').insert({
      location_id: body.companyId, name: body.name, token_hash: hash, campaign_id: body.campaignId ?? null, job_type_keys: body.jobTypeKeys,
      days_ahead: body.daysAhead, min_lead_hours: body.minLeadHours,
    }).select('id'), 'create booking link');
    return { widgetId: rows[0]?.id ?? null, token, embedPath: `/api/fieldservice/widget?token=${token}` };
  }
  await fsWrite(pm.from('booking_widgets').update({ is_active: false }).eq('id', body.id).select('id'), 'disable booking link');
  return { ok: true };
});
