import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { MaterialsView } from '@/components/manufacturing/MaterialsView';
import '@/components/ops/ops.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Shop material' };
export const dynamic = 'force-dynamic';

/** Material demand from production orders, draft purchase orders, receiving. */
export default async function ShopMaterialPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Shop material', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Shop material" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        {companyId ? <MaterialsView companyId={companyId} today={todayIso()} jobs={jobRefs(o).filter((j) => j.companyId === companyId && j.open)} /> : <OneCompany what="Shop material" />}
      </Page>
    </>
  );
}
