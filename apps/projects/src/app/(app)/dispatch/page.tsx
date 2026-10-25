import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has } from '@/lib/pm/ops/scope';
import { loadDispatchDay } from '@/lib/pm/ops/field-queries';
import { one } from '@/lib/pm/db';
import { WO_COLS, type WorkOrderRow } from '@/lib/pm/ops/types';
import { APP_TZ, todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { DispatchBoard } from '@/components/ops/dispatch/DispatchBoard';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';
import { DispatchFieldStrip } from '@/components/fieldservice/dispatch/DispatchFieldStrip';
import '@/components/fieldservice/fs.css';
import { loadBookingSetup, loadCapacityGrid, loadDispatchExtras } from '@/lib/fieldservice/queries';
import { addDays } from '@/lib/time';

export const metadata: Metadata = { title: 'Dispatch' };
export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DispatchPage({ searchParams }: { searchParams: { day?: string; wo?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/dispatch');
  const today = todayIso();
  const day = searchParams.day && DAY.test(searchParams.day) ? searchParams.day : today;
  const data = await loadDispatchDay(o.db, { companyIds: o.companyIds }, day);
  const focusWo = searchParams.wo && UUID.test(searchParams.wo) ? searchParams.wo : null;
  const focusOrder = focusWo && !data.queue.some((q) => q.work_order_id === focusWo)
    ? one<WorkOrderRow>(await o.db.schema('pm').from('work_orders').select(WO_COLS).eq('id', focusWo).in('location_id', o.companyIds).maybeSingle(), 'work order')
    : null;

  if (!has(o, 'dispatch') && data.queue.length === 0 && data.assignments.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Dispatch" />
          <ModuleOff title="Dispatch" what="The dispatch board puts visits on technicians by the hour, with capacity and skills checked." />
        </Page>
      </>
    );
  }

  const jobLabels: Record<string, string> = {};
  for (const id of [...data.queue.map((q) => q.job_id), ...data.orders.map((w) => w.job_id), ...(focusOrder ? [focusOrder.job_id] : [])]) {
    const l = o.jobs.label(id);
    if (l) jobLabels[id] = o.multi ? [l, o.jobs.company(id)].filter(Boolean).join(' · ') : l;
  }
  const overdue = data.queue.filter((q) => q.is_overdue).length;
  // field-service strip (capacity, on call, blocks) for one company at a time
  const fsCompany = o.scope.company?.id ?? (o.companyIds.length === 1 ? o.companyIds[0]! : null);
  const [fsSetup, fsCells, fsExtras] = fsCompany
    ? await Promise.all([loadBookingSetup(o.db, [fsCompany]), loadCapacityGrid(o.db, fsCompany, day, 1), loadDispatchExtras(o.db, [fsCompany], `${day}T00:00:00Z`, `${addDays(day, 1)}T06:00:00Z`)])
    : [null, [], { events: [], onCall: [] }];
  const empNames = Object.fromEntries(data.employees.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ')]));

  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(data.queue.length)} unassigned`, strong: true },
          ...(overdue ? [`${count(overdue)} past due`] : []),
          `${count(data.assignments.length)} booked on ${day === today ? 'today' : day}`,
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title="Dispatch" />
        {fsSetup && fsSetup.businessUnits.length > 0 && (
          <DispatchFieldStrip cells={fsCells} businessUnits={fsSetup.businessUnits} windows={fsSetup.windows} onCall={fsExtras.onCall} events={fsExtras.events} employees={empNames} day={day} />
        )}
        <DispatchBoard
          day={day}
          today={today}
          tz={APP_TZ}
          queue={data.queue}
          assignments={data.assignments}
          orders={data.orders}
          crews={data.crews}
          members={data.members}
          employees={data.employees}
          skills={data.skills}
          employeeSkills={data.employeeSkills}
          board={data.board}
          jobLabels={jobLabels}
          companies={o.companies}
          activeCompanyId={o.scope.company?.id ?? null}
          focusWo={focusWo}
          focusOrder={focusOrder}
        />
      </Page>
    </>
  );
}
