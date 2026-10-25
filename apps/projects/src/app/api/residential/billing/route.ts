export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import type { IntegrityItem } from '@/lib/residential/types';
import { Day, Text, Uuid } from '@/lib/residential/schemas';

/** The daily billing-integrity scan for a company (RES-125). */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing', 'change_order'], query: z.object({ companyId: Uuid }) }, async ({ db, query }) =>
  ({ items: await resRpc<IntegrityItem[]>(db, 'res_billing_integrity', { p_location: query.companyId }) }));

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('milestone_release'), itemId: Uuid, reason: Text(500).nullish() }),
  z.object({ op: z.literal('cost_plus'), jobId: Uuid, through: Day.nullish() }),
  z.object({ op: z.literal('draw_package'), drawId: Uuid, titleDateDown: Day.nullish() }),
  z.object({ op: z.literal('draw_shortfall'), drawId: Uuid }),
  z.object({ op: z.literal('co_exposure'), companyId: Uuid }),
]);

const OPS = { draw_package: { cap: 'projects.billing', action: 'edit' }, co_exposure: { cap: 'projects.change_orders', action: 'view' } } as const;

export const POST = route({ access: { cap: 'projects.billing', action: 'create' }, ops: OPS, mask: ['billing', 'draw', 'cost', 'change_order'], body: Op }, async ({ db, body }) => {
  switch (body.op) {
    case 'milestone_release': return { billingRequestId: await resRpc<string | null>(db, 'res_release_milestone', { p_item: body.itemId, p_reason: body.reason ?? null }) };
    case 'cost_plus': return resRpc(db, 'res_generate_cost_plus_billing', { p_job: body.jobId, p_through: body.through ?? null });
    case 'draw_package': return resRpc(db, 'res_assemble_draw_package', { p_draw: body.drawId, p_title_date_down: body.titleDateDown ?? null });
    case 'draw_shortfall': return { billingRequestId: await resRpc<string>(db, 'res_request_draw_shortfall', { p_draw: body.drawId }) };
    case 'co_exposure': return resRpc(db, 'res_co_exposure_summary', { p_location: body.companyId });
  }
});
