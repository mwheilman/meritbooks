export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { getJobBilling } from '@/lib/pm/money/queries';
import { assertMode, loadMoneyJob } from '@/lib/pm/money/job';
import { callRpc, wrote } from '@/lib/pm/money/rpc';
import { Fraction, IsoDate, PosCents, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';

const SovLine = z.object({
  sovLineId: Uuid,
  pctComplete: Fraction.nullish(),
  workToDateCents: PosCents.nullish(),
  thisPeriodCents: z.number().int().min(-1e13).max(1e13).nullish(),
  storedMaterialsCents: PosCents.nullish(),
});

const Body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('progress'), pct: Fraction.nullish(), asOf: IsoDate.nullish() }),
  z.object({ mode: z.literal('sov'), sovVersionId: Uuid, periodEnd: IsoDate, lines: z.array(SovLine).max(500), replaceDraftId: Uuid.nullish() }),
  z.object({ mode: z.literal('milestone'), ids: z.array(Uuid).min(1, 'Pick at least one completed milestone.').max(200), occurredOn: IsoDate.nullish() }),
  z.object({ mode: z.literal('tm'), from: IsoDate, to: IsoDate, occurredOn: IsoDate.nullish() }),
  z.object({ mode: z.literal('retainage'), amountCents: PosCents.nullish(), occurredOn: IsoDate.nullish() }),
  z.object({ mode: z.literal('fixed'), description: Text200.min(1, 'Describe what is being billed.'), amountCents: PosCents.refine((n) => n > 0, 'Enter an amount above zero.'), occurredOn: IsoDate.nullish(), memo: Text2000.nullish() }),
]);

/** Everything the Billing tab shows: requests and lines, the queue view, pay applications, SOV, deposits, allowances, milestones. */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing', 'job'] }, async ({ db, params }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  return getJobBilling(db, job.job_id);
});

/**
 * Draft a billing request with the generator for the mode the job type allows. Every
 * generator writes a DRAFT created by the caller, so someone else approves and sends it.
 */
export const POST = route({ access: { cap: 'projects.billing', action: 'create' }, mask: 'billing', body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  const subject = 'billing request' as const;
  switch (body.mode) {
    case 'progress': {
      assertMode(job, 'progress');
      const id = await callRpc<string>(db, 'generate_progress_billing', { p_job: job.job_id, p_as_of: body.asOf ?? null, p_pct: body.pct ?? null }, subject);
      return { requestId: id };
    }
    case 'sov': {
      assertMode(job, 'sov');
      if (body.replaceDraftId) {
        const d = one<{ id: string; status: string; billing_subtype: string | null; job_id: string }>(
          await pm(db).from('billing_requests').select('id, status, billing_subtype, job_id').eq('id', body.replaceDraftId).maybeSingle(), 'draft pay application');
        if (!d || d.job_id !== job.job_id || d.billing_subtype !== 'SOV' || d.status !== 'DRAFT') {
          throw new HttpError(409, 'That draft pay application changed; reload the tab.', 'STALE_DRAFT');
        }
        await callRpc(db, 'void_billing_request', { p_request: d.id, p_reason: 'Redrafted with new amounts' }, subject);
      }
      const lines = body.lines.map((l) => {
        const o: Record<string, unknown> = { sov_line_id: l.sovLineId };
        if (l.pctComplete != null) o.pct_complete = l.pctComplete;
        else if (l.workToDateCents != null) o.work_to_date_cents = l.workToDateCents;
        else if (l.thisPeriodCents != null) o.this_period_cents = l.thisPeriodCents;
        if (l.storedMaterialsCents != null) o.stored_materials_cents = l.storedMaterialsCents;
        return o;
      });
      const id = await callRpc<string>(db, 'generate_sov_billing', { p_job: job.job_id, p_sov_version: body.sovVersionId, p_period_end: body.periodEnd, p_lines: lines }, subject);
      return { requestId: id };
    }
    case 'milestone': {
      assertMode(job, 'milestone');
      const id = await callRpc<string>(db, 'generate_milestone_billing', { p_job: job.job_id, p_ids: body.ids, p_occurred_on: body.occurredOn ?? null }, subject);
      return { requestId: id };
    }
    case 'tm': {
      assertMode(job, 'tm');
      if (body.to < body.from) throw new HttpError(422, 'The end date is before the start date.', 'VALIDATION');
      const id = await callRpc<string>(db, 'generate_tm_billing', { p_job: job.job_id, p_from: body.from, p_to: body.to, p_occurred_on: body.occurredOn ?? null }, subject);
      return { requestId: id };
    }
    case 'retainage': {
      assertMode(job, 'retainage');
      const id = await callRpc<string>(db, 'request_retainage_release', { p_job: job.job_id, p_amount_cents: body.amountCents ?? null, p_occurred_on: body.occurredOn ?? null }, subject);
      return { requestId: id };
    }
    case 'fixed': {
      assertMode(job, 'fixed');
      const r = wrote<{ id: string }>(
        await pm(db).from('billing_requests').insert({
          job_id: job.job_id, billing_type: 'MILESTONE', billing_subtype: 'FIXED', occurred_on: body.occurredOn ?? undefined, memo: body.memo ?? body.description,
        }).select('id').single(),
        subject,
      );
      const res = await pm(db).from('billing_request_lines').insert({ billing_request_id: r.id, line_no: 1, sort: 0, description: body.description, amount_cents: body.amountCents }).select('id');
      if (res.error) {
        await pm(db).from('billing_requests').delete().eq('id', r.id);
        wrote(res, subject);
      }
      return { requestId: r.id };
    }
  }
});
