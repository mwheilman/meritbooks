import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { PACKAGE_ITEMS } from '@/lib/pm/ops/draw-math';
import { Cents, Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const PackageKey = z.enum(PACKAGE_ITEMS.map((p) => p.key) as [string, ...string[]]);

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set_lines'),
    lines: z.array(z.object({ budgetLineId: Uuid, requestedCents: Cents, retainageReleasedCents: Cents.default(0) })).max(500),
  }),
  z.object({ op: z.literal('set_package'), key: PackageKey, done: z.boolean() }),
  z.object({ op: z.literal('update'), periodEnd: Day.optional(), notes: Text(2000).nullish() }),
  z.object({ op: z.literal('submit') }),
  z.object({
    op: z.literal('inspect'),
    result: z.enum(['PASSED', 'CONDITIONAL', 'FAILED']),
    pctComplete: z.number().min(0).max(1).nullish(),
    inspector: Text(160).nullish(),
    inspectedOn: Day.nullish(),
    notes: Text(2000).nullish(),
  }),
  z.object({ op: z.literal('approve'), lenderApprover: Text(160).nullish(), lines: z.array(z.object({ lineId: Uuid, approvedCents: Cents })).max(500).default([]) }),
  z.object({ op: z.literal('return'), reason: Need(500, 'Say what the lender wants corrected') }),
  z.object({ op: z.literal('cancel'), reason: Text(300).nullish() }),
  z.object({ op: z.literal('fund'), fundedOn: Day.nullish(), wireRef: Text(120).nullish(), fundedCents: Cents.nullish() }),
]);

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const d = await own<{ id: string; status: string; package: Record<string, unknown> }>(db, 'draws', 'id, status, package', { id: params.drawId! }, 'That draw was not found.');
  const pm = db.schema('pm');
  const editable = d.status === 'DRAFT' || d.status === 'RETURNED';
  switch (body.op) {
    case 'set_lines': {
      if (!editable) throw new HttpError(422, 'A submitted draw is locked. Return it for correction to change it.', 'PM_DRAW_LOCKED');
      const existing = rows<{ id: string; draw_budget_line_id: string }>(await pm.from('draw_lines').select('id, draw_budget_line_id').eq('draw_id', d.id), 'draw lines');
      const byLine = new Map(existing.map((e) => [e.draw_budget_line_id, e.id]));
      for (const l of body.lines) {
        const id = byLine.get(l.budgetLineId);
        const zero = l.requestedCents === 0 && l.retainageReleasedCents === 0;
        if (id && zero) await write(pm.from('draw_lines').delete().eq('id', id).select('id'), 'clear draw line');
        else if (id) await write(pm.from('draw_lines').update({ requested_cents: l.requestedCents, retainage_released_cents: l.retainageReleasedCents }).eq('id', id).select('id'), 'update draw line');
        else if (!zero) await write(pm.from('draw_lines').insert({ draw_id: d.id, draw_budget_line_id: l.budgetLineId, requested_cents: l.requestedCents, retainage_released_cents: l.retainageReleasedCents }).select('id'), 'add draw line');
      }
      return { ok: true };
    }
    case 'set_package': {
      if (!editable) throw new HttpError(422, 'The package locks when the draw is submitted. Return it for correction to change it.', 'PM_DRAW_LOCKED');
      await write(pm.from('draws').update({ package: { ...(d.package ?? {}), [body.key]: body.done } }).eq('id', d.id).select('id'), 'update draw package');
      return { ok: true };
    }
    case 'update': {
      if (!editable) throw new HttpError(422, 'A submitted draw is locked.', 'PM_DRAW_LOCKED');
      const patch: Record<string, unknown> = {};
      if (body.periodEnd !== undefined) patch.period_end = body.periodEnd;
      if (body.notes !== undefined) patch.notes = body.notes || null;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('draws').update(patch).eq('id', d.id).select('id'), 'update draw');
      return { ok: true };
    }
    case 'submit':
      await call(db, 'submit_draw', { p_draw: d.id });
      return { ok: true };
    case 'inspect':
      await call(db, 'record_draw_inspection', { p_draw: d.id, p_result: body.result, p_pct_complete: body.pctComplete ?? null, p_inspector: body.inspector || null, p_inspected_on: body.inspectedOn ?? null, p_notes: body.notes || null });
      return { ok: true };
    case 'approve':
      await call(db, 'approve_draw', {
        p_draw: d.id,
        p_line_approvals: body.lines.length ? body.lines.map((l) => ({ line_id: l.lineId, approved_cents: l.approvedCents })) : null,
        p_lender_approver: body.lenderApprover || null,
      });
      return { ok: true };
    case 'return':
      await call(db, 'return_draw', { p_draw: d.id, p_reason: body.reason });
      return { ok: true };
    case 'cancel':
      await call(db, 'cancel_draw', { p_draw: d.id, p_reason: body.reason || null });
      return { ok: true };
    case 'fund':
      await call(db, 'fund_draw', { p_draw: d.id, p_funded_on: body.fundedOn ?? null, p_wire_ref: body.wireRef || null, p_funded_cents: body.fundedCents ?? null });
      return { ok: true };
  }
});
