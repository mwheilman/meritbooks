export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { getJobFinancials, listCostCodeStatus } from '@/lib/pm/money/queries';
import { loadMoneyJob } from '@/lib/pm/money/job';
import { callRpc } from '@/lib/pm/money/rpc';

export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['budget', 'job'] }, async ({ db, params }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  const [costCodes, financials] = await Promise.all([listCostCodeStatus(db, job.job_id), getJobFinancials(db, job.job_id)]);
  return { costCodes, financials };
});

export interface RefreshResult {
  status: 'ok' | 'busy';
  seen?: number;
  applied?: number;
  stale?: number;
  duplicate?: number;
  rejected?: number;
}

/** pm.refresh_job_costs: apply the org's pending JOB_COST events from Merit Books now ("busy" when a drain is running). */
export const POST = route({ access: { cap: 'projects.financials', action: 'view' } }, async ({ db, params }) => {
  await loadMoneyJob(db, params.jobId!);
  const r = await callRpc<RefreshResult>(db, 'refresh_job_costs', {}, 'record');
  return r;
});
