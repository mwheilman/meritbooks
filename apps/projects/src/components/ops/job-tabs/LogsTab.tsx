import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadLogs } from '@/lib/pm/ops/records-queries';
import { employeeNames } from '@/lib/pm/people';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { pageScope } from '@/lib/scope';
import { todayIso } from '@/lib/time';
import { LogsView } from '../records/LogsView';
import '../ops.css';

/** Job tab: daily logs for this job (pm.field_logs), newest day first. */
export async function LogsTab({ jobId }: JobTabProps) {
  const [db, scope] = await Promise.all([requireDb(), pageScope()]);
  const [job, logs] = await Promise.all([jobOption(db, jobId), loadLogs(db, { companyIds: [], jobId }, (id) => id === jobId, 500)]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const names = await employeeNames(db, logs.map((l) => l.created_by));
  return <LogsView logs={logs} jobs={[job]} loggedJobIds={[]} today={todayIso()} meUserId={scope?.userId ?? ''} names={names} fixedJobId={jobId} />;
}
