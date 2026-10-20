import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadTechSetup, loadWorkOrders } from '@/lib/pm/ops/field-queries';
import { customerNames } from '@/lib/pm/ops/scope';
import { jobOption, packKeyOf, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { APP_TZ, todayIso } from '@/lib/time';
import { WorkOrderQueue } from '../work-orders/WorkOrderQueue';
import '../ops.css';

/** Job tab: this job's work orders / visits / repair orders, with create fixed to the job. */
export async function WorkOrdersTab({ jobId, companyId }: JobTabProps) {
  const db = await requireDb();
  const [job, list, setup, packKey] = await Promise.all([
    jobOption(db, jobId),
    loadWorkOrders(db, { companyIds: [companyId], jobId }),
    loadTechSetup(db, { companyIds: [companyId] }),
    packKeyOf(db, companyId),
  ]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const customers = await customerNames(db, [...list.claims.map((c) => c.payer_customer_id), ...list.orders.map((w) => w.payer_customer_id)]);
  return (
    <WorkOrderQueue
      orders={list.orders}
      assignments={list.assignments}
      claims={list.claims}
      assets={list.assets}
      employees={Object.fromEntries(setup.employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]))}
      jobs={[job]}
      jobTypes={[]}
      companies={[]}
      defaultCompanyId={companyId}
      packKey={packKey}
      skills={setup.skills}
      customers={customers}
      tz={APP_TZ}
      today={todayIso()}
      capped={list.capped}
      focusId={null}
      openNew={false}
      initialBand="all"
      initialView="orders"
      fixedJobId={jobId}
    />
  );
}
