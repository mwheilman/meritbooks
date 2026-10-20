import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadDraws } from '@/lib/pm/ops/development-queries';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { todayIso } from '@/lib/time';
import { DrawsView } from '../draws/DrawsView';
import '../ops.css';

/** Job tab: the job's loan budget, continuation sheet, in-balance test and draws. */
export async function DrawsTab({ jobId, companyId }: JobTabProps) {
  const db = await requireDb();
  const [job, data] = await Promise.all([jobOption(db, jobId), loadDraws(db, { companyIds: [companyId], jobId })]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  return <DrawsView {...data} jobs={[job]} today={todayIso()} initialScheduleId={null} fixedJobId={jobId} />;
}
