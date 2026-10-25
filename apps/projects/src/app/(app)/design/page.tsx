import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { DesignHub } from '@/components/design/DesignHub';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Design procurement' };
export const dynamic = 'force-dynamic';

/** Every component across the studio's projects by its next date: order, ship, deliver, install, deposits and balances. */
export default async function DesignProcurementPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.selections', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Design procurement', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Design procurement" />
        {!allowed ? <Denied what="Design procurement" /> : (companyId ? <DesignHub companyId={companyId} today={todayIso()} jobs={jobRefs(o).filter((j) => j.companyId === companyId)} /> : <OneCompany what="Design procurement" />)}
      </Page>
    </>
  );
}
