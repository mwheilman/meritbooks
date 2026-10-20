import { KV, WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadJobProduction, loadProduction } from '@/lib/pm/ops/production-queries';
import { jobOption, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { hoursText } from '@/lib/pm/ops/shop-math';
import { todayIso } from '@/lib/time';
import { ProductionView } from '../production/ProductionView';
import '../ops.css';

/** Job tab: this job's production orders (engineering → shop → complete) and its shop roll-up. */
export async function ProductionTab({ jobId, companyId }: JobTabProps) {
  const db = await requireDb();
  const [job, data, roll] = await Promise.all([jobOption(db, jobId), loadProduction(db, { companyIds: [companyId], jobId }), loadJobProduction(db, jobId)]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  return (
    <div className="stack">
      {roll && roll.orders > 0 && (
        <div className="surface" style={{ padding: 16 }}>
          <KV items={[
            { term: 'Orders', value: `${roll.orders} · ${roll.in_engineering} in engineering · ${roll.in_shop} in the shop · ${roll.complete} complete` },
            { term: 'Standard time', value: hoursText(roll.std_minutes ?? 0) },
            { term: 'Actual so far', value: hoursText(roll.actual_minutes ?? 0) },
            { term: 'Left to build', value: hoursText(roll.remaining_std_minutes ?? 0) },
            ...(roll.any_late ? [{ term: 'Promise dates', value: <span className="neg b">An order is past its promised date</span> }] : []),
          ]} />
        </div>
      )}
      <ProductionView
        orders={data.orders}
        load={data.load}
        floor={data.floor}
        centers={data.centers}
        routings={data.routings}
        steps={data.steps}
        jobs={[job]}
        jobLabels={{ [jobId]: job.label }}
        companyId={companyId}
        today={todayIso()}
        initialTab="board"
        focusId={null}
        fixedJobId={jobId}
      />
    </div>
  );
}
