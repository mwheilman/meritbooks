export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { parsePickList } from '@/lib/dealer/catalog';
import { CompanyOnlyQ, Qty, Req, Text, Uuid } from '@/lib/dealer/schemas';

/** Counter speed by day (pm.v_dlr_counter_speed) and the last 30 days of lost sales. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'parts_ticket', query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [speed, lost] = await Promise.all([
    xrows<{ day: string; tickets: number; median_seconds: string | null; avg_seconds: string | null; pct_under_60s: string | null }>(
      db.schema('pm').from('v_dlr_counter_speed').select('day, tickets, median_seconds, avg_seconds, pct_under_60s').eq('location_id', query.company).gte('day', since).order('day', { ascending: false }), 'counter speed'),
    xrows<{ id: string; part_number: string; description: string | null; qty: number; reason: string | null; customer_type: string | null; created_at: string }>(
      db.schema('pm').from('dlr_lost_sales').select('id, part_number, description, qty, reason, customer_type, created_at').eq('location_id', query.company).gte('created_at', since).order('created_at', { ascending: false }).limit(200), 'lost sales'),
  ]);
  return {
    speed: speed.map((s) => ({ day: s.day, tickets: s.tickets, medianSeconds: s.median_seconds == null ? null : Number(s.median_seconds), avgSeconds: s.avg_seconds == null ? null : Number(s.avg_seconds), pctUnder60: s.pct_under_60s == null ? null : Number(s.pct_under_60s) })),
    lost,
  };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('scan'), companyId: Uuid, code: Req(60, 'A code') }),
  z.object({ op: z.literal('lost_sale'), companyId: Uuid, partNumber: Req(40, 'The part number'), qty: Qty.default(1), reason: Text(40).nullish(), customerType: Text(20).nullish(), ticketId: Uuid.nullish(), description: Text(200).nullish() }),
  z.object({ op: z.literal('pick_list'), ticketId: Uuid, text: Req(50_000, 'The pick list') }),
]);

/** The keyboard / scanner counter: scan a code, log a lost sale, drop a catalog pick list on a ticket. */
export const POST = route({ access: { cap: 'projects.store', action: 'view' }, ops: { lost_sale: { cap: 'projects.store', action: 'create' }, pick_list: { cap: 'projects.store', action: 'edit' } }, mask: ['part', 'parts_ticket'], body: Op }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'scan':
      assertCompany(tenant, body.companyId);
      return xcall(db, 'dlr_scan', { p_location: body.companyId, p_code: body.code });
    case 'lost_sale':
      assertCompany(tenant, body.companyId);
      return { id: await xcall<string>(db, 'dlr_log_lost_sale', { p_location: body.companyId, p_part_number: body.partNumber, p_qty: body.qty, p_customer_type: body.customerType ?? null, p_reason: body.reason ?? null, p_ticket: body.ticketId ?? null, p_description: body.description ?? null }) };
    case 'pick_list': {
      const lines = parsePickList(body.text);
      if (!lines.length) return { added: [], unknown: [], parsed: 0 };
      const r = await xcall<{ added: unknown[]; unknown: unknown[] }>(db, 'dlr_add_pick_list', { p_ticket: body.ticketId, p_lines: lines });
      return { ...r, parsed: lines.length };
    }
  }
});
