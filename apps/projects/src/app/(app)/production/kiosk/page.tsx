import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { KioskView } from '@/components/manufacturing/KioskView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Shop station' };
export const dynamic = 'force-dynamic';

/** The shop-floor station: badge in, start, pause, finish, remake; works offline. */
export default async function ShopStationPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Shop station', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Shop station" />
        {companyId ? <KioskView companyId={companyId} /> : <OneCompany what="Shop station" />}
      </Page>
    </>
  );
}
