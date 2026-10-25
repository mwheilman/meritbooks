export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { IsoDate, Rate, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';
import type { CommitmentRow } from '@/lib/pm/money/types';
import { CommitmentLineSchema, commitmentLineRow } from '@/lib/pm/money/commitment-lines';
import { loadCommitment } from '@/lib/pm/money/load';
import { approvalSummary, decideObject } from '@/lib/approvals/server';

function draftOnly(c: CommitmentRow) {
  if (c.status !== 'DRAFT') throw new HttpError(422, 'Lines change only while the commitment is a draft. Use a change order on the commitment instead.', 'PM_COMMITMENT_LOCKED');
}

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), type: z.enum(['PO', 'SUBCONTRACT']).optional(), vendorId: Uuid.nullish(), title: Text200.min(1).optional(), description: Text2000.nullish(), retainagePct: Rate.optional() }),
  z.object({ op: z.literal('add_line'), line: CommitmentLineSchema }),
  z.object({ op: z.literal('update_line'), lineId: Uuid, line: CommitmentLineSchema }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({ op: z.literal('approve') }),
  z.object({ op: z.literal('execute'), executedOn: IsoDate.nullish() }),
  z.object({ op: z.literal('close') }),
  z.object({ op: z.literal('void'), reason: Text2000.nullish() }),
  z.object({ op: z.literal('hold'), hold: z.boolean(), reason: Text2000.nullish() }),
  z.object({ op: z.literal('delete') }),
]);

/**
 * Draft edits (RLS draft_update / column grants) and the state moves:
 * approve_commitment (tier + separation of duties) · execute_commitment · close_commitment ·
 * void_commitment · set_commitment_hold. Each approved move sends JOB_COMMITMENT to Merit Books.
 */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, ops: { approve: { cap: 'projects.commitments', action: 'approve' }, execute: { cap: 'projects.commitments', action: 'approve' } }, mask: 'commitment', body: Body }, async ({ db, params, body }) => {
  const c = await loadCommitment(db, params.commitmentId!);
  switch (body.op) {
    case 'update': {
      if (c.status !== 'DRAFT') throw new HttpError(422, 'Only a draft commitment can be edited.', 'PM_COMMITMENT_NOT_DRAFT');
      const patch: Record<string, unknown> = {};
      if (body.type) patch.commitment_type = body.type;
      if (body.vendorId !== undefined) patch.vendor_id = body.vendorId;
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.retainagePct !== undefined) patch.retainage_pct = body.retainagePct;
      wrote(await pm(db).from('commitments').update(patch).eq('id', c.id).select('id'), 'commitment');
      return { ok: true };
    }
    case 'add_line': {
      draftOnly(c);
      const last = one<{ line_no: number }>(await pm(db).from('commitment_lines').select('line_no').eq('commitment_id', c.id).order('line_no', { ascending: false }).limit(1).maybeSingle(), 'last line');
      const l = wrote<{ id: string }>(await pm(db).from('commitment_lines').insert({ ...commitmentLineRow(body.line), commitment_id: c.id, line_no: (last?.line_no ?? 0) + 1 }).select('id').single(), 'commitment');
      return { lineId: l.id };
    }
    case 'update_line': {
      draftOnly(c);
      wrote(await pm(db).from('commitment_lines').update(commitmentLineRow(body.line)).eq('id', body.lineId).eq('commitment_id', c.id).select('id'), 'commitment');
      return { ok: true };
    }
    case 'remove_line': {
      draftOnly(c);
      wrote(await pm(db).from('commitment_lines').delete().eq('id', body.lineId).eq('commitment_id', c.id).select('id'), 'commitment');
      return { ok: true };
    }
    case 'approve': {
      // through the approvals engine (1113): tier + role + limit + preparer ≠ approver; approve_commitment runs at the last step
      const r = await decideObject(db, 'commitment', c.id);
      if (r.status === 'not_needed') {
        const eventId = await callRpc<string | null>(db, 'approve_commitment', { p_commitment: c.id }, 'commitment');
        return { sent: !!eventId, approval: approvalSummary(r) };
      }
      return { sent: !!r.result?.event_id, approval: approvalSummary(r) };
    }
    case 'execute': {
      const eventId = await callRpc<string | null>(db, 'execute_commitment', { p_commitment: c.id, p_executed_on: body.executedOn ?? null }, 'commitment');
      return { sent: !!eventId };
    }
    case 'close': {
      const eventId = await callRpc<string | null>(db, 'close_commitment', { p_commitment: c.id }, 'commitment');
      return { sent: !!eventId };
    }
    case 'void': {
      const eventId = await callRpc<string | null>(db, 'void_commitment', { p_commitment: c.id, p_reason: body.reason ?? null }, 'commitment');
      return { sent: !!eventId };
    }
    case 'hold': {
      const eventId = await callRpc<string | null>(db, 'set_commitment_hold', { p_commitment: c.id, p_hold: body.hold, p_reason: body.reason ?? null }, 'commitment');
      return { sent: !!eventId };
    }
    case 'delete': {
      if (c.status !== 'DRAFT') throw new HttpError(422, 'Only a draft can be deleted. Void it instead.', 'PM_COMMITMENT_NOT_DRAFT');
      wrote(await pm(db).from('commitments').delete().eq('id', c.id).select('id'), 'commitment');
      return { ok: true };
    }
  }
});
