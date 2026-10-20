import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { loadCostCodesFor, loadTime, loadTimeTargets } from '@/lib/pm/ops/records-queries';
import { shiftDay } from '@/lib/pm/ops/dispatch-math';
import { mondayOf } from '@/lib/pm/ops/week';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { pageScope } from '@/lib/scope';
import { todayIso } from '@/lib/time';
import { TimeView } from '../records/TimeView';
import '../ops.css';

/** Job tab: time on this job. Loads the last 12 weeks and the next one; the tab steps through weeks locally. */
export async function TimeTab({ jobId, companyId }: JobTabProps) {
  const [db, scope] = await Promise.all([requireDb(), pageScope()]);
  const today = todayIso();
  const monday = mondayOf(today);
  const [job, entries, employees, codes, targets] = await Promise.all([
    jobOption(db, jobId),
    loadTime(db, { companyIds: [companyId], jobId }, shiftDay(monday, -84), shiftDay(monday, 13), (id) => id === jobId),
    listEmployees(db),
    loadCostCodesFor(db, [companyId]),
    loadTimeTargets(db, { companyIds: [companyId], jobId }),
  ]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const me = employees.find((e) => e.clerk_user_id === scope?.userId) ?? null;
  return (
    <TimeView weekStart={monday} today={today} entries={entries} employees={employees} meEmployeeId={me?.id ?? null} meUserId={scope?.userId ?? ''}
      jobs={[job]} costCodes={codes.filter((c) => c.job_id == null || c.job_id === jobId)} workOrders={targets.workOrders} operations={targets.operations} fixedJobId={jobId} />
  );
}
