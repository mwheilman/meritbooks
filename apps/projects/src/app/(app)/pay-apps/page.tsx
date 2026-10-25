import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { jobsWithActiveSov, loadPayApps } from '@/lib/commercial/screens';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { PayAppsView } from '@/components/commercial/PayAppsView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pay applications' };

/** Owner pay applications, pencil to final, across jobs (CGC-41..44). Contract-side money: billing + contract value. */
export default async function PayAppsPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/pay-apps');
  const jobs = jobRefs(o);
  const ids = jobs.map((j) => j.id);
  const [rows, draftable] = await Promise.all([loadPayApps(o.db, ids), jobsWithActiveSov(o.db, jobs.filter((j) => j.open).map((j) => j.id))]);
  const working = rows.filter((r) => ['PENCIL', 'PENCIL_SENT', 'REVISE', 'CERTIFIED'].includes(r.stage ?? ''));
  const due = working.reduce((s, r) => s + Number(r.current_payment_due_cents ?? 0), 0);
  return (
    <>
      <PageCrumbs items={[{ label: 'Pay applications' }]} />
      <PageLine facts={[o.where, { label: `${count(working.length)} in progress`, strong: true }, { label: `${money(due, { decimals: 0 })} due`, tnum: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Pay applications" />
        <PayAppsView rows={rows} jobs={jobs} draftable={draftable} today={todayIso()} />
      </Page>
    </>
  );
}
