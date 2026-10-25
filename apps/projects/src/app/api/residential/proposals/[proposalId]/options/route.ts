export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resWrote } from '@/lib/residential/rpc';
import { OptionZ, Uuid } from '@/lib/residential/schemas';

const toDb = (o: Partial<z.infer<typeof OptionZ>>) => {
  const out: Record<string, unknown> = {};
  if (o.kind !== undefined) out.kind = o.kind;
  if (o.groupKey !== undefined) out.group_key = o.groupKey;
  if (o.tier !== undefined) out.tier = o.tier;
  if (o.label !== undefined) out.label = o.label;
  if (o.description !== undefined) out.description = o.description;
  if (o.imageUrl !== undefined) out.image_url = o.imageUrl;
  if (o.sort !== undefined) out.sort = o.sort;
  return out;
};

/** Good / better / best alternates (one per group) and add-ons on a DRAFT proposal. */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: OptionZ }, async ({ db, params, body, tenant }) => {
  const row = resWrote<Array<{ id: string }>>(await pm(db).from('res_proposal_options')
    .insert({ org_id: tenant.orgId, proposal_id: params.proposalId!, ...toDb(body), is_selected: false }).select('id'));
  return { optionId: row[0]?.id ?? null };
});

export const PATCH = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: OptionZ.partial().extend({ optionId: Uuid }) }, async ({ db, params, body }) => {
  const { optionId, ...rest } = body;
  resWrote(await pm(db).from('res_proposal_options').update(toDb(rest)).eq('id', optionId).eq('proposal_id', params.proposalId!).select('id'));
  return { ok: true };
});

export const DELETE = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, query: z.object({ optionId: Uuid }) }, async ({ db, params, query }) => {
  resWrote(await pm(db).from('res_proposal_options').delete().eq('id', query.optionId).eq('proposal_id', params.proposalId!).select('id'));
  return { ok: true };
});
