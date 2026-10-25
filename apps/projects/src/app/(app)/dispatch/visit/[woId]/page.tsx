import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { VisitWorkspace } from '@/components/fieldservice/options/VisitWorkspace';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadVisit } from '@/lib/fieldservice/queries';
import { todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Visit' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The technician's visit: pre-job brief, good / better / best, kitchen-table close, replacement lead. */
export default async function VisitPage({ params }: { params: { woId: string } }) {
  if (!UUID.test(params.woId)) notFound();
  const g = await fsPage([['projects.jobs', 'view']]);
  if (!g) return null;
  const { o } = g;
  const wo = await o.db.schema('pm').from('work_orders').select('id, number, summary, location_id, job_id, status').eq('id', params.woId).maybeSingle();
  if (wo.error || !wo.data) notFound();
  const w = wo.data as { id: string; number: string; summary: string; location_id: string; job_id: string; status: string };
  const showEligible = g.access.byCompany[w.location_id]?.has('projects.dispatch:view') ?? false;
  const data = await loadVisit(o.db, w.id, w.location_id, { eligible: showEligible });
  const company = o.companyName(w.location_id) ?? o.where;
  const job = o.jobs.label(w.job_id);
  return (
    <>
      <PageLine facts={[company, { label: w.number, strong: true }, ...(job ? [job] : []), w.status.toLowerCase().replace('_', ' ')]} />
      <Page>
        <PageHead eyebrow={[company, w.number].join(' // ')} title={w.summary} />
        <VisitWorkspace
          workOrderId={w.id}
          today={todayIso()}
          data={data}
          showEligible={showEligible}
          canRequestDeposit={g.access.byCompany[w.location_id]?.has('projects.billing:create') ?? false}
          seesCost={g.access.byCompany[w.location_id]?.has('projects.financials:view') ?? false}
        />
      </Page>
    </>
  );
}
