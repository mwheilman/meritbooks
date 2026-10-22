import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs } from '@/lib/pm/ops/scope';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { loadCostCodesFor, loadTime, loadTimeTargets } from '@/lib/pm/ops/records-queries';
import { shiftDay } from '@/lib/pm/ops/dispatch-math';
import { mondayOf } from '@/lib/pm/ops/week';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { TimeView } from '@/components/ops/records/TimeView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Time' };
export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function TimePage({ searchParams }: { searchParams: { week?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/time');
  const today = todayIso();
  const weekStart = mondayOf(searchParams.week && DAY.test(searchParams.week) ? searchParams.week : today);
  const inScope = (id: string) => o.jobs.byId.has(id);
  const [entries, employees, codes, targets] = await Promise.all([
    loadTime(o.db, { companyIds: o.companyIds }, weekStart, shiftDay(weekStart, 6), inScope),
    listEmployees(o.db),
    loadCostCodesFor(o.db, o.companyIds),
    loadTimeTargets(o.db, { companyIds: o.companyIds }),
  ]);
  if (!has(o, 'time') && entries.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Time" />
          <ModuleOff title="Time" what="Hours by job and cost code, against work orders and shop operations." />
        </Page>
      </>
    );
  }
  const me = employees.find((e) => e.clerk_user_id === o.scope.userId) ?? null;
  const hours = entries.reduce((s, t) => s + Number(t.hours), 0);
  const drafts = entries.filter((t) => t.approval_state === 'DRAFT').length;
  return (
    <>
      <PageLine facts={[o.where, { label: `${(Math.round(hours * 100) / 100).toLocaleString('en-US')} hours this week`, strong: true }, `${count(new Set(entries.map((t) => t.employee_id ?? t.user_id)).size)} people`, ...(drafts ? [`${count(drafts)} not submitted`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Time" />
        <TimeView
          key={weekStart}
          weekStart={weekStart}
          today={today}
          entries={entries}
          employees={employees}
          meEmployeeId={me?.id ?? null}
          meUserId={o.scope.userId}
          jobs={jobRefs(o)}
          costCodes={codes}
          workOrders={targets.workOrders}
          operations={targets.operations}
        />
      </Page>
    </>
  );
}
