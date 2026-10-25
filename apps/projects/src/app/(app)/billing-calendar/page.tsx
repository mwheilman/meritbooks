import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadBilledByJob, loadBillingCalendar } from '@/lib/commercial/screens';
import { calendarState } from '@/lib/commercial/screen-logic';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { BillingCalendarView } from '@/components/commercial/BillingCalendarView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Billing calendar' };

/** Every GC's cutoff, pencil due date, form and portal in one calendar (CGC-102). */
export default async function BillingCalendarPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/billing-calendar');
  const jobs = jobRefs(o);
  const inScope = new Set(jobs.map((j) => j.id));
  const rows = (await loadBillingCalendar(o.db, o.companyIds)).filter((r) => inScope.has(r.job_id));
  const billed = await loadBilledByJob(o.db, rows.map((r) => r.job_id));
  const today = todayIso();
  const late = rows.filter((r) => calendarState(r, today) === 'LATE').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Billing calendar' }]} />
      <PageLine facts={[o.where, { label: `${count(rows.length)} jobs billing`, strong: true }, `${count(late)} past the cutoff`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Billing calendar" />
        <BillingCalendarView rows={rows} billed={billed} today={today} />
      </Page>
    </>
  );
}
