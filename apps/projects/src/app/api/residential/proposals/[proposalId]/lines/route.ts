export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resWrote } from '@/lib/residential/rpc';
import { LineZ, Uuid, lineToDb } from '@/lib/residential/schemas';

/**
 * Lines of a DRAFT proposal, written through RLS (projects.estimates:edit at the company). The
 * database prices each line (labor at pay + burden + overhead, overhead kept out of cost) and
 * re-totals the proposal; a sent proposal refuses changes (revise it).
 */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: LineZ }, async ({ db, params, body, tenant }) => {
  const row = resWrote<Array<{ id: string }>>(await pm(db).from('res_proposal_lines')
    .insert({ org_id: tenant.orgId, proposal_id: params.proposalId!, ...lineToDb(body) }).select('id'));
  return { lineId: row[0]?.id ?? null };
});

export const PATCH = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, body: LineZ.extend({ lineId: Uuid }) }, async ({ db, params, body }) => {
  const { lineId, ...rest } = body;
  resWrote(await pm(db).from('res_proposal_lines').update(lineToDb(rest)).eq('id', lineId).eq('proposal_id', params.proposalId!).select('id'));
  return { ok: true };
});

export const DELETE = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: false, query: z.object({ lineId: Uuid }) }, async ({ db, params, query }) => {
  resWrote(await pm(db).from('res_proposal_lines').delete().eq('id', query.lineId).eq('proposal_id', params.proposalId!).select('id'));
  return { ok: true };
});
