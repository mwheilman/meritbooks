import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { scopedJobs } from '@/lib/pm/scoped';
import { listOpenTasks } from '@/lib/pm/work';
import { addDays, todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ScheduleBoard } from '@/components/schedule/ScheduleBoard';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Schedule' };

export default async function SchedulePage() {
  const scope = await pageScope();
  if (!scope) return null;
  await guardPage('/schedule');
  const db = await requireDb();
  const [jobs, tasks] = await Promise.all([scopedJobs(db, scope), listOpenTasks(db)]);
  const today = todayIso();
  const weekEnd = addDays(today, 6);
  const board = tasks.filter((t) => jobs.byId.has(t.job_id)).map((t) => ({ ...t, jobLabel: jobs.label(t.job_id) ?? '', company: jobs.company(t.job_id) }));
  const overdue = board.filter((t) => t.due_on && t.due_on < today).length;
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageLine facts={[where, { label: `${count(board.length)} open tasks`, strong: true }, ...(overdue ? [`${count(overdue)} overdue`] : [])]} />
      <Page>
        <PageHead eyebrow={where} title="Schedule" />
        <ScheduleBoard tasks={board} today={today} weekEnd={weekEnd} multi={scope.companyIds.length > 1} />
      </Page>
    </>
  );
}
