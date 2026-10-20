import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Need, ScheduleTerms, Uuid } from '@/lib/pm/ops/schemas';

const Category = z.enum(['LAND', 'HARD', 'SOFT', 'FINANCING', 'INTEREST_RESERVE', 'CONTINGENCY', 'DEVELOPER_FEE', 'OTHER']);

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), terms: ScheduleTerms.partial() }),
  z.object({ op: z.literal('add_line'), description: Need(200, 'Describe the line'), category: Category, originalCents: Cents, retainageApplies: z.boolean().nullish() }),
  z.object({ op: z.literal('update_line'), lineId: Uuid, description: Need(200, 'Describe the line').optional(), category: Category.optional(), originalCents: Cents.optional(), retainageApplies: z.boolean().optional() }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
  z.object({ op: z.literal('activate') }),
  z.object({ op: z.literal('revise_line'), lineId: Uuid, revisedCents: Cents, reason: Need(500, 'Say why the line moves (the lender asks)') }),
  z.object({ op: z.literal('create_draw'), periodEnd: Day }),
  z.object({ op: z.literal('delete') }),
]);

const TERM_COLS: Record<string, string> = {
  lenderName: 'lender_name', lenderCustomerId: 'lender_customer_id', loanNumber: 'loan_number', loanCommitmentCents: 'loan_commitment_cents',
  equityRequiredCents: 'equity_required_cents', interestReserveCents: 'interest_reserve_cents', interestRate: 'interest_rate',
  projectedMonthlyInterestCents: 'projected_monthly_interest_cents', retainagePct: 'retainage_pct', requiresInspection: 'requires_inspection',
  equityFirst: 'equity_first', loanClosedOn: 'loan_closed_on', maturityOn: 'maturity_on', notes: 'notes',
};

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const s = await own<{ id: string; job_id: string; status: string }>(db, 'draw_schedules', 'id, job_id, status', { id: params.scheduleId! }, 'That loan budget was not found.');
  const pm = db.schema('pm');
  const draftOnly = () => {
    if (s.status !== 'DRAFT') throw new HttpError(422, 'The loan budget is active. Reallocate a line with a reason instead.', 'PM_DRAW_BUDGET_LOCKED');
  };
  switch (body.op) {
    case 'update': {
      draftOnly();
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body.terms)) if (v !== undefined && TERM_COLS[k]) patch[TERM_COLS[k]!] = v === '' ? null : v;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('draw_schedules').update(patch).eq('id', s.id).select('id'), 'update loan terms');
      return { ok: true };
    }
    case 'add_line': {
      draftOnly();
      const last = rows<{ line_no: number }>(await pm.from('draw_budget_lines').select('line_no').eq('draw_schedule_id', s.id).order('line_no', { ascending: false }).limit(1), 'last line');
      const n = (last[0]?.line_no ?? 0) + 1;
      await write(
        pm.from('draw_budget_lines').insert({
          draw_schedule_id: s.id, job_id: s.job_id, line_no: n, sort: n, description: body.description, category: body.category,
          original_cents: body.originalCents, retainage_applies: body.retainageApplies ?? null,
        }).select('id'),
        'add loan budget line',
      );
      return { ok: true };
    }
    case 'update_line': {
      draftOnly();
      const patch: Record<string, unknown> = {};
      if (body.description !== undefined) patch.description = body.description;
      if (body.category !== undefined) patch.category = body.category;
      if (body.originalCents !== undefined) {
        patch.original_cents = body.originalCents;
        patch.revised_cents = body.originalCents; // a draft budget has no revisions yet
      }
      if (body.retainageApplies !== undefined) patch.retainage_applies = body.retainageApplies;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('draw_budget_lines').update(patch).eq('id', body.lineId).eq('draw_schedule_id', s.id).select('id'), 'update loan budget line');
      return { ok: true };
    }
    case 'remove_line':
      draftOnly();
      await write(pm.from('draw_budget_lines').delete().eq('id', body.lineId).eq('draw_schedule_id', s.id).select('id'), 'remove loan budget line');
      return { ok: true };
    case 'activate':
      await call(db, 'activate_draw_schedule', { p_schedule: s.id });
      return { ok: true };
    case 'revise_line':
      await call(db, 'revise_draw_budget_line', { p_line: body.lineId, p_revised_cents: body.revisedCents, p_reason: body.reason });
      return { ok: true };
    case 'create_draw': {
      const id = await call<string>(db, 'create_draw', { p_schedule: s.id, p_period_end: body.periodEnd });
      return { ok: true, drawId: id };
    }
    case 'delete':
      draftOnly();
      await write(pm.from('draw_schedules').delete().eq('id', s.id).select('id'), 'delete loan budget');
      return { ok: true };
  }
});
