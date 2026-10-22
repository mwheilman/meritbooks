import { z } from 'zod';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';

const Body = z.object({
  originalCents: z.number().int().min(0).max(1e13),
  kind: z.enum(['PRIME', 'MASTER', 'RELEASE', 'SERVICE_AGREEMENT']).optional(),
  /** Fraction 0..0.2 (10% = 0.1). */
  retentionPct: z.number().min(0).max(1).nullish(),
  progressBasis: z.enum(['NONE', 'COST_TO_COST', 'PHYSICAL_PCT', 'UNITS', 'MILESTONES']).nullish(),
  contractId: z.string().uuid().nullish(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

/** Set the contract (pm.set_contract; sends JOB_PROGRESS CONTRACT_SET to Books when present). */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: 'job', body: Body }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  const id = must(
    await db.schema('pm').rpc('set_contract', {
      p_job: job.job_id,
      p_original_cents: body.originalCents,
      p_kind: body.kind ?? 'PRIME',
      p_retention_pct: body.retentionPct ?? null,
      p_progress_basis: body.progressBasis ?? null,
      p_contract_id: body.contractId ?? null,
      p_as_of: body.asOf ?? null,
    }),
    'set contract',
  ) as string;
  return { contractId: id };
});
