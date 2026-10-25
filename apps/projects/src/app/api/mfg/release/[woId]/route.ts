export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { Text } from '@/lib/dealer/schemas';

/** Release-to-shop gates for a production order: drawings, BOM, routing, selections, budget, deposit, material, CAD. */
export const GET = route({ access: { cap: 'projects.production', action: 'view' }, mask: 'billing' }, async ({ db, params }) => xcall(db, 'mfg_release_check', { p_wo: params.woId! }));

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('release'), overrideReason: Text(500).nullish() }),
  z.object({ op: z.literal('restandard') }),
]);

/** Release (soft gates overridable with a reason by someone holding financials:edit; the database decides), or re-standard the routing from the BOM. */
export const POST = route({ access: { cap: 'projects.production', action: 'edit' }, mask: 'billing', body: Op }, async ({ db, params, body }) => {
  if (body.op === 'restandard') return { operations: await xcall<number>(db, 'mfg_restandard_operations', { p_wo: params.woId! }) };
  return xcall(db, 'mfg_release', { p_wo: params.woId!, p_override_reason: body.overrideReason || null });
});
