import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadUnits } from '@/lib/pm/ops/development-queries';
import { customerNames } from '@/lib/pm/ops/scope';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { todayIso } from '@/lib/time';
import { UnitsView } from '../units/UnitsView';
import '../ops.css';

/** Job tab: the development's lots / units and its entitlement milestones. */
export async function UnitsTab({ jobId, companyId }: JobTabProps) {
  const db = await requireDb();
  const [job, data] = await Promise.all([jobOption(db, jobId), loadUnits(db, { companyIds: [companyId], jobId }, (id) => id === jobId)]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const buyers = await customerNames(db, data.units.map((u) => u.buyer_customer_id));
  return <UnitsView units={data.units} entitlements={data.entitlements} buyers={buyers} jobs={[job]} today={todayIso()} initialTab="units" fixedJobId={jobId} />;
}
