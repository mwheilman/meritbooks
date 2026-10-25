import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { PursuitBoard } from '@/components/development/PursuitBoard';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Pursuits' };
export const dynamic = 'force-dynamic';

/** The pursuit pipeline (RED-03) and due diligence (RED-04). */
export default async function PursuitsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.financials', 'view', companyId);
  const jobs = [...o.jobs.byId.values()].filter((j) => j.location_id === companyId).map((j) => ({ id: j.job_id, label: o.jobs.label(j.job_id) ?? j.job_id }));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Pursuits', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Pursuits" actions={<ButtonLink variant="quiet" href="/development">Development</ButtonLink>} />
        {!allowed ? <Denied what="Pursuits" /> : (companyId ? <PursuitBoard companyId={companyId} today={todayIso()} jobs={jobs} /> : <OneCompany what="Pursuits" />)}
      </Page>
    </>
  );
}
