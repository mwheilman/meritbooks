import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadPayAppWorkspace } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { PayAppWorkspace } from '@/components/commercial/PayAppWorkspace';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pay application' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pay-application workspace: G702 / G703, pencil → certify → final, signature and portal output (CGC-41/43/44). */
export default async function PayAppPage({ params }: { params: { requestId: string } }) {
  if (!UUID.test(params.requestId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/pay-apps');
  const jobs = jobRefs(o);
  const label = new Map(jobs.map((j) => [j.id, j.label]));
  const data = await loadPayAppWorkspace(o.db, params.requestId, (id) => label.get(id) ?? 'Job');
  if (!data) notFound();
  const job = jobs.find((j) => j.id === data.jobId);
  const title = `Application #${data.applicationNo ?? '—'}`;
  return (
    <>
      <PageCrumbs items={[{ label: 'Pay applications', href: '/pay-apps' }, { label: data.jobLabel, href: `/jobs/${data.jobId}?tab=billing` }, { label: title }]} />
      <PageLine facts={[data.jobLabel, { label: title, strong: true }, ...(data.periodEnd ? [`Period ending ${data.periodEnd}`] : [])]} />
      <Page>
        <PageHead eyebrow={[data.jobLabel, job?.customer].filter(Boolean).join(' // ')} title={title} />
        <PayAppWorkspace data={data} today={todayIso()} canApprove={holds(access, 'projects.billing:approve', job?.companyId ?? null)} />
      </Page>
    </>
  );
}
