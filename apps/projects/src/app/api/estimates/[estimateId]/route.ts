export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm, rows } from '@/lib/pm/db';
import { ESTIMATE_LINE_COLS } from '@/lib/pm/money/queries';
import { loadEstimate } from '@/lib/pm/money/load';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { IsoDate, Rate, Text200, Text2000 } from '@/lib/pm/money/schemas';
import type { EstimateLineRow } from '@/lib/pm/money/types';

export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: 'estimate' }, async ({ db, params }) => {
  const estimate = await loadEstimate(db, params.estimateId!);
  const lines = rows<EstimateLineRow>(await pm(db).from('v_estimate_lines_masked').select(ESTIMATE_LINE_COLS).eq('estimate_id', estimate.id).order('sort').order('line_no'), 'estimate lines');
  return { estimate, lines };
});

const Patch = z.object({
  title: Text200.min(1).optional(),
  retainagePct: Rate.nullish(),
  validUntil: IsoDate.nullish(),
  notes: Text2000.nullish(),
});

/** Edit a DRAFT estimate's header (RLS draft_update; status moves only through the functions). */
export const PATCH = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: 'estimate', body: Patch }, async ({ db, params, body }) => {
  const e = await loadEstimate(db, params.estimateId!);
  if (e.status !== 'DRAFT') throw new HttpError(422, 'Only a draft estimate can be edited. Revise it to make changes.', 'PM_ESTIMATE_NOT_DRAFT');
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.retainagePct !== undefined) patch.retainage_pct = body.retainagePct;
  if (body.validUntil !== undefined) patch.valid_until = body.validUntil;
  if (body.notes !== undefined) patch.notes = body.notes;
  wrote(await pm(db).from('estimates').update(patch).eq('id', e.id).select('id'), 'estimate');
  return { ok: true };
});

/**
 * Delete a DRAFT. A revision's draft can be deleted only when the version it replaced was
 * accepted; otherwise the earlier version is superseded and the estimate would have no open version.
 */
export const DELETE = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: 'estimate' }, async ({ db, params }) => {
  const e = await loadEstimate(db, params.estimateId!);
  if (e.status !== 'DRAFT') throw new HttpError(422, 'Only a draft estimate can be deleted. Decline it instead.', 'PM_ESTIMATE_NOT_DRAFT');
  if (e.supersedes_id) {
    const prev = one<{ status: string }>(await pm(db).from('estimates').select('status').eq('id', e.supersedes_id).maybeSingle(), 'previous version');
    if (prev && prev.status !== 'ACCEPTED') {
      throw new HttpError(409, 'Deleting this draft would leave the estimate with no open version. Decline it instead.', 'ESTIMATE_LAST_OPEN');
    }
  }
  wrote(await pm(db).from('estimates').delete().eq('id', e.id).select('id'), 'estimate');
  return { ok: true };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send') }),
  z.object({ op: z.literal('accept') }),
  z.object({ op: z.literal('decline'), reason: Text2000.nullish() }),
  z.object({ op: z.literal('revise') }),
]);

interface AcceptResult { estimate_id: string; budget_id: string; contract_id: string | null; contract_created: boolean; progress_event_id: string | null }

/** send_estimate · accept_estimate (budget + contract) · decline_estimate · revise_estimate. */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: 'estimate', body: Op }, async ({ db, params, body }) => {
  const e = await loadEstimate(db, params.estimateId!);
  if (body.op === 'send') {
    await callRpc(db, 'send_estimate', { p_estimate: e.id }, 'estimate');
    return { ok: true };
  }
  if (body.op === 'decline') {
    await callRpc(db, 'decline_estimate', { p_estimate: e.id, p_reason: body.reason ?? null }, 'estimate');
    return { ok: true };
  }
  if (body.op === 'revise') {
    const id = await callRpc<string>(db, 'revise_estimate', { p_estimate: e.id }, 'estimate');
    return { estimateId: id };
  }
  const r = await callRpc<AcceptResult>(db, 'accept_estimate', { p_estimate: e.id }, 'estimate');
  return { budgetId: r.budget_id, contractId: r.contract_id, contractCreated: r.contract_created, progressSent: !!r.progress_event_id, totalCents: e.total_cents, costCents: e.cost_total_cents };
});
