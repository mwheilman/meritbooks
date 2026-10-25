import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { FlooringHome } from '@/components/flooring/FlooringHome';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Flooring' };
export const dynamic = 'force-dynamic';

/** The flooring week: install capacity in square feet, readiness, and the jobs to work. */
export default async function FlooringPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Flooring', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Flooring" />
        {!allowed ? <Denied what="Flooring" /> : (companyId ? <FlooringHome companyId={companyId} today={todayIso()} jobs={jobRefs(o).filter((j) => j.companyId === companyId)} /> : <OneCompany what="Flooring" />)}
      </Page>
    </>
  );
}
