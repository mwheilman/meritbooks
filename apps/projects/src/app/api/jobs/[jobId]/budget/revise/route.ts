import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { must, route } from '@/lib/api';
import { getBudget } from '@/lib/pm/budget';
import { draftBudget, emitBudgetRevised } from '@/lib/pm/budget-ops';
import { loadJob } from '@/lib/pm/guarded';
import { todayIso } from '@/lib/time';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start') }),
  z.object({ op: z.literal('save'), budgetId: z.string().uuid() }),
  z.object({ op: z.literal('discard'), budgetId: z.string().uuid() }),
]);

/**
 * Revise budget: `start` copies the effective budget's lines into a REVISED draft;
 * `save` approves it (superseding the previous revision) and sends BUDGET_REVISED to
 * Merit Books when Books is present and a contract exists; `discard` drops the draft.
 * Projects never touches cost in Books directly.
 */
export const POST = route({ body: Body }, async ({ db, params, body, tenant }) => {
  const job = await loadJob(db, params.jobId!);
  const pm = db.schema('pm');

  if (body.op === 'start') {
    const bundle = await getBudget(db, job.job_id);
    if (bundle.draft) return { budgetId: bundle.draft.id, reused: true };
    if (!bundle.effective) throw new HttpError(422, 'Build and approve the original budget first.', 'NO_BUDGET');
    const nextVersion = Math.max(0, ...bundle.budgets.filter((b) => b.kind === 'REVISED').map((b) => b.version)) + 1;
    const created = must(
      await pm.from('budgets').insert({ job_id: job.job_id, kind: 'REVISED', version: nextVersion, status: 'DRAFT', label: `Revision ${nextVersion}` }).select('id').single(),
      'start revision',
    ) as { id: string };
    const source = bundle.lines.filter((l) => l.budget_id === bundle.effective!.id);
    if (source.length) {
      must(
        await pm.from('budget_lines').insert(source.map((l) => ({ budget_id: created.id, cost_code_id: l.cost_code_id, description: l.description, amount_cents: l.amount_cents, sort: l.sort }))).select('id'),
        'copy lines',
      );
    }
    return { budgetId: created.id, reused: false };
  }

  const draft = await draftBudget(db, job.job_id, body.budgetId);
  if (draft.kind !== 'REVISED') throw new HttpError(422, 'That draft is the original budget; approve it from the budget tab.', 'NOT_REVISION');

  if (body.op === 'discard') {
    must(await pm.from('budgets').delete().eq('id', draft.id).select('id'), 'discard revision');
    return { ok: true };
  }

  must(await pm.from('budgets').update({ status: 'SUPERSEDED' }).eq('job_id', job.job_id).eq('kind', 'REVISED').eq('status', 'APPROVED').select('id'), 'supersede');
  must(await pm.from('budgets').update({ status: 'APPROVED', as_of: todayIso() }).eq('id', draft.id).select('id'), 'save revision');
  return { ok: true, books: await emitBudgetRevised(db, job.job_id, tenant.booksPresent) };
});
