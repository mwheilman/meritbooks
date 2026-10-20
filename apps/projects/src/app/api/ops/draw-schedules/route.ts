import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { getBudget, listCostCodes } from '@/lib/pm/budget';
import { write } from '@/lib/pm/ops/rpc';
import { ScheduleTerms, Uuid } from '@/lib/pm/ops/schemas';

const Body = ScheduleTerms.extend({ jobId: Uuid, seedFromBudget: z.boolean().default(true) });

const HARD = new Set(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT']);

/** A draft loan budget for a job; optionally seeded from the job's effective budget lines. */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const pm = db.schema('pm');
  const r = await write<Array<{ id: string }>>(
    pm.from('draw_schedules').insert({
      job_id: job.job_id, lender_name: body.lenderName, lender_customer_id: body.lenderCustomerId ?? null, loan_number: body.loanNumber || null,
      loan_commitment_cents: body.loanCommitmentCents, equity_required_cents: body.equityRequiredCents, interest_reserve_cents: body.interestReserveCents,
      interest_rate: body.interestRate ?? null, projected_monthly_interest_cents: body.projectedMonthlyInterestCents ?? null, retainage_pct: body.retainagePct,
      requires_inspection: body.requiresInspection, equity_first: body.equityFirst, loan_closed_on: body.loanClosedOn ?? null, maturity_on: body.maturityOn ?? null,
      notes: body.notes || null,
    }).select('id'),
    'create loan budget',
  );
  const id = r[0]?.id;
  if (!id) throw new HttpError(500, 'The loan budget was not created. Try again.', 'CREATE_FAILED');

  let seeded = 0;
  if (body.seedFromBudget) {
    const [bundle, codes] = await Promise.all([getBudget(db, job.job_id), listCostCodes(db, job.location_id, { jobId: job.job_id, includeInactive: true })]);
    const byCode = new Map(codes.map((c) => [c.id, c]));
    const lines = bundle.effective ? bundle.lines.filter((l) => l.budget_id === bundle.effective!.id && l.amount_cents > 0) : [];
    if (lines.length) {
      await write(
        pm.from('draw_budget_lines').insert(lines.map((l, i) => {
          const cc = byCode.get(l.cost_code_id);
          return {
            draw_schedule_id: id, job_id: job.job_id, line_no: i + 1, sort: i,
            description: [cc?.code, l.description || cc?.name].filter(Boolean).join(' ').slice(0, 200) || `Line ${i + 1}`,
            category: cc && HARD.has(cc.cost_type) ? 'HARD' : 'SOFT', cost_code_id: l.cost_code_id, budget_line_id: l.id, original_cents: l.amount_cents,
          };
        })).select('id'),
        'seed loan budget',
      );
      seeded = lines.length;
    }
  }
  return { scheduleId: id, seeded };
});
