import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadPunch } from '@/lib/pm/ops/records-queries';
import { vendorNames } from '@/lib/pm/ops/scope';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { todayIso } from '@/lib/time';
import { PunchView } from '../records/PunchView';
import '../ops.css';

/** Job tab: punch, warranty and callback items on this job. */
export async function PunchTab({ jobId }: JobTabProps) {
  const db = await requireDb();
  const [job, items] = await Promise.all([jobOption(db, jobId), loadPunch(db, { companyIds: [], jobId }, (id) => id === jobId)]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const vendors = await vendorNames(db, items.map((i) => i.responsible_vendor_id));
  return <PunchView items={items} jobs={[job]} vendors={vendors} today={todayIso()} fixedJobId={jobId} />;
}
