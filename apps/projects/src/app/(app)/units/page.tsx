import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs, customerNames } from '@/lib/pm/ops/scope';
import { loadUnits } from '@/lib/pm/ops/development-queries';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { UnitsView } from '@/components/ops/units/UnitsView';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Lots and units' };
export const dynamic = 'force-dynamic';

export default async function UnitsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const data = await loadUnits(o.db, { companyIds: o.companyIds }, (id) => o.jobs.byId.has(id));
  if (!has(o, 'lots_units') && data.units.length === 0 && data.entitlements.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Lots and units" />
          <ModuleOff title="Lots and units" what="Lots and homes with sale status, list, contract and lender release prices and closing dates, plus entitlements." />
        </Page>
      </>
    );
  }
  const buyers = await customerNames(o.db, data.units.map((u) => u.buyer_customer_id));
  const contract = data.units.filter((u) => u.status === 'UNDER_CONTRACT');
  const closed = data.units.filter((u) => u.status === 'CLOSED').length;
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(data.units.length)} lots and units`, strong: true }, `${count(contract.length)} under contract · ${money(contract.reduce((s, u) => s + (u.contract_price_cents ?? 0), 0), { decimals: 0 })}`, `${count(closed)} closed`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Lots and units" />
        <UnitsView units={data.units} entitlements={data.entitlements} buyers={buyers} jobs={jobRefs(o)} today={todayIso()} initialTab={searchParams.tab === 'entitlements' ? 'entitlements' : 'units'} />
      </Page>
    </>
  );
}
