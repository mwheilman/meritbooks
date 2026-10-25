import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { OrdersTracker } from '@/components/flooring/OrdersTracker';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Orders and receiving' };
export const dynamic = 'force-dynamic';

/** Special orders (FLR-23), unmatched receiving (FLR-28), shade lots (FLR-26) and counter sales (FLR-19). */
export default async function OrdersAndReceivingPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Orders and receiving', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Orders and receiving" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Orders and receiving" /> : (companyId ? <OrdersTracker companyId={companyId} today={todayIso()} /> : <OneCompany what="Orders and receiving" />)}
      </Page>
    </>
  );
}
