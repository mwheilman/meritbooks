export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { depthErrorCopy } from '@/lib/dealer/errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { KIOSK_ACTIONS } from '@/lib/mfg/kiosk-queue';
import { Req, Text, Uuid } from '@/lib/dealer/schemas';

/** Who is clocked on at the station right now (v_mfg_open_punches), for the shop-floor screen. No money. */
export const GET = route({ access: { cap: 'projects.production', action: 'edit' }, mask: false, query: z.object({ company: Uuid }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const [open, alerts] = await Promise.all([
    xrows<Record<string, unknown>>(db.schema('pm').from('v_mfg_open_punches').select('*').eq('location_id', query.company).limit(200), 'open punches'),
    xcall<{ badges: Array<{ employee_id: string; name: string | null; wrong_pins_24h: number; last_at: string }>; locked_stations: number }>(db, 'mfg_badge_alerts', { p_location: query.company }),
  ]);
  return { open, alerts };
});

const Event = z.object({
  client_event_id: z.string().min(8).max(60),
  session_token: z.string().min(16).max(200),
  action: z.enum(KIOSK_ACTIONS),
  operation_id: Uuid.nullish(),
  good_qty: z.number().min(0).max(1e7).nullish(),
  scrap_qty: z.number().min(0).max(1e7).nullish(),
  qty: z.number().min(0).max(1e7).nullish(),
  reason: Text(300).nullish(),
  indirect_code: Text(30).nullish(),
  part_label: Text(60).nullish(),
  remake_reason: Text(30).nullish(),
  at: z.string().datetime({ offset: true }),
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('identify'), companyId: Uuid, badge: Req(64, 'The badge'), pin: Text(12).nullish() }),
  z.object({ op: z.literal('events'), companyId: Uuid, events: z.array(Event).min(1).max(100) }),
  z.object({ op: z.literal('set_badge'), companyId: Uuid, employeeId: Uuid, badge: Req(64, 'The badge'), pin: z.string().regex(/^\d{4,8}$/, 'Every badge needs a PIN of 4–8 digits') }),
]);

/**
 * The shop-floor station (a signed-in seat holding production:edit): a badge (+ PIN) starts a
 * worker session; taps queue on the device and replay here in order (the database dedupes on
 * client_event_id, so a resend never double-counts).
 */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: false, body: Op }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  switch (body.op) {
    case 'identify': {
      // Refusals come back as data (so the lockout counters persist): turn them into the plain HTTP answer.
      const r = await xcall<{ ok: boolean; code?: string; station_tries_left?: number | null }>(db, 'mfg_kiosk_identify', { p_location: body.companyId, p_badge: body.badge, p_pin: body.pin || null });
      if (!r.ok) {
        const code = r.code ?? 'PM_KIOSK_BADGE';
        const copy = depthErrorCopy({ code: '28000', message: `${code}: ` });
        const status = code === 'PM_KIOSK_RATE_LIMIT' ? 429 : code === 'PM_KIOSK_DEVICE_LOCKED' ? 423 : 401;
        const left = (code === 'PM_KIOSK_PIN' || code === 'PM_KIOSK_BADGE') && r.station_tries_left != null && r.station_tries_left <= 5 ? ` ${r.station_tries_left} more failures lock this station.` : '';
        throw new HttpError(status, `${copy?.error ?? 'Not signed in.'}${left}`, code);
      }
      return r;
    }
    case 'events':
      return xcall(db, 'mfg_kiosk_events', { p_location: body.companyId, p_events: body.events });
    case 'set_badge':
      return { id: await xcall<string>(db, 'mfg_set_badge', { p_location: body.companyId, p_employee: body.employeeId, p_badge: body.badge, p_pin: body.pin }) };
  }
});
