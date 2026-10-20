export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { getBudget, listCostCodes } from '@/lib/pm/budget';
import { draftBudget, emitBudgetRevised } from '@/lib/pm/budget-ops';
import { loadJob } from '@/lib/pm/guarded';
import { todayIso } from '@/lib/time';

const Cents = z.number().int().min(-1e13).max(1e13);
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_original') }),
  z.object({ op: z.literal('add_line'), budgetId: z.string().uuid(), costCodeId: z.string().uuid(), description: z.string().trim().max(200).nullish(), amountCents: Cents }),
  z.object({ op: z.literal('update_line'), lineId: z.string().uuid(), costCodeId: z.string().uuid().optional(), description: z.string().trim().max(200).nullish(), amountCents: Cents.optional() }),
  z.object({ op: z.literal('remove_line'), lineId: z.string().uuid() }),
  z.object({ op: z.literal('approve_original'), budgetId: z.string().uuid() }),
]);

export const GET = route({}, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  const [bundle, costCodes] = await Promise.all([getBudget(db, job.job_id), listCostCodes(db, job.location_id, { jobId: job.job_id })]);
  return { ...bundle, costCodes };
});

/** Budget lines: create the original, add / edit / remove lines on a draft, approve the original. */
export const POST = route({ body: Body }, async ({ db, params, body, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  const pm = db.schema('pm');

  if (body.op === 'create_original') {
    const existing = must(await pm.from('budgets').select('id').eq('job_id', job.job_id).eq('kind', 'ORIGINAL').neq('status', 'SUPERSEDED').limit(1), 'budgets') as Array<{ id: string }>;
    if (existing.length) throw new HttpError(409, 'This job already has an original budget.', 'BUDGET_EXISTS');
    const b = must(await pm.from('budgets').insert({ job_id: job.job_id, kind: 'ORIGINAL', version: 1, status: 'DRAFT', label: 'Original budget' }).select('id').single(), 'create budget') as { id: string };
    return { budgetId: b.id };
  }

  if (body.op === 'add_line') {
    await draftBudget(db, job.job_id, body.budgetId);
    const last = must(await pm.from('budget_lines').select('sort').eq('budget_id', body.budgetId).order('sort', { ascending: false }).limit(1), 'last line') as Array<{ sort: number }>;
    const line = must(
      await pm.from('budget_lines').insert({
        budget_id: body.budgetId, cost_code_id: body.costCodeId, description: body.description ?? null,
        amount_cents: body.amountCents, sort: (last[0]?.sort ?? -1) + 1,
      }).select('id').single(),
      'add line',
    ) as { id: string };
    return { lineId: line.id };
  }

  if (body.op === 'update_line' || body.op === 'remove_line') {
    const line = must(await pm.from('budget_lines').select('id, budget_id').eq('id', body.lineId).maybeSingle(), 'line') as { id: string; budget_id: string } | null;
    if (!line) throw new HttpError(404, 'That budget line was not found.', 'NOT_FOUND');
    await draftBudget(db, job.job_id, line.budget_id);
    if (body.op === 'remove_line') {
      must(await pm.from('budget_lines').delete().eq('id', line.id).select('id'), 'remove line');
      return { ok: true };
    }
    const patch: Record<string, unknown> = {};
    if (body.costCodeId) patch.cost_code_id = body.costCodeId;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.amountCents !== undefined) patch.amount_cents = body.amountCents;
    must(await pm.from('budget_lines').update(patch).eq('id', line.id).select('id'), 'update line');
    return { ok: true };
  }

  // approve_original
  const b = await draftBudget(db, job.job_id, body.budgetId);
  if (b.kind !== 'ORIGINAL') throw new HttpError(422, 'Save a revision from the revision bar instead.', 'NOT_ORIGINAL');
  const lines = must(await pm.from('budget_lines').select('id').eq('budget_id', b.id).limit(1), 'lines') as Array<{ id: string }>;
  if (!lines.length) throw new HttpError(422, 'Add at least one line before approving the budget.', 'BUDGET_EMPTY');
  must(await pm.from('budgets').update({ status: 'APPROVED', as_of: todayIso() }).eq('id', b.id).select('id'), 'approve budget');
  return { ok: true, books: await emitBudgetRevised(db, job.job_id, tenant.booksPresent) };
});
