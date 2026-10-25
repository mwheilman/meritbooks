import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { SalesWorkspace } from '@/components/fieldservice/sales/SalesWorkspace';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadPendingAcceptances, nameMap, rpcLoad } from '@/lib/fieldservice/completion';
import type { FollowupQueueRow, Pipeline } from '@/lib/fieldservice/completion-types';

export const metadata: Metadata = { title: 'Sales follow-up' };
export const dynamic = 'force-dynamic';

/** Comfort-advisor pipeline (FS-57), unsold-estimate follow-up (FS-56), online acceptances (FS-59). */
export default async function SalesPage() {
  const g = await fsPage([['projects.leads', 'view'], ['projects.estimates', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Sales follow-up" /><OneCompany what="The sales pipeline and estimate follow-ups" /></Page></>);
  const [pipeline, queue, accepted, plans] = await Promise.all([
    rpcLoad<Pipeline>(o.db, 'fs_advisor_pipeline', { p_location: companyId, p_from: null, p_to: null }, { by_advisor: [], by_source: [], open: [] }),
    rpcLoad<FollowupQueueRow[]>(o.db, 'fs_followup_queue', { p_location: companyId }, []),
    loadPendingAcceptances(o.db, companyId),
    o.db.schema('pm').from('financing_plans').select('id, name').eq('location_id', companyId).eq('is_active', true).order('name'),
  ]);
  const employees = await nameMap(o.db, 'employees', [...pipeline.data.open.map((x) => x.advisor_employee_id), ...queue.data.map((q) => q.owner_employee_id)]);
  const company = o.companyName(companyId) ?? o.where;
  const stalled = pipeline.data.open.filter((x) => x.stalled).length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(pipeline.data.open.length)} open`, strong: true }, ...(stalled ? [`${count(stalled)} stalled`] : []), `${count(queue.data.length)} open estimates`]} />
      <Page>
        <PageHead eyebrow={company} title="Sales follow-up" />
        <SalesWorkspace companyId={companyId} pipeline={pipeline.data} queue={queue.data} accepted={accepted.data}
          error={pipeline.error ?? queue.error ?? accepted.error} employees={employees}
          plans={((plans.data ?? []) as Array<{ id: string; name: string }>)}
          canEdit={g.can('projects.leads', 'edit') || g.can('projects.estimates', 'edit')}
          canFinalize={g.can('projects.estimates', 'edit') || g.can('projects.dispatch', 'edit')} />
      </Page>
    </>
  );
}
