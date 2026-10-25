import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { RemakesView } from '@/components/manufacturing/RemakesView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Remakes' };
export const dynamic = 'force-dynamic';

/** Remakes and the cost of quality by reason. */
export default async function RemakesPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const ores = companyId ? await o.db.schema('pm').from('work_orders').select('id, number, summary').eq('location_id', companyId).eq('kind', 'PRODUCTION').not('status', 'in', '(CLOSED,CANCELLED)').order('number', { ascending: false }).limit(300) : null;
  const orders = ((ores?.data ?? []) as Array<{ id: string; number: string; summary: string }>);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Remakes', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Remakes" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        {companyId ? <RemakesView companyId={companyId} today={todayIso()} orders={orders} /> : <OneCompany what="Remakes" />}
      </Page>
    </>
  );
}
