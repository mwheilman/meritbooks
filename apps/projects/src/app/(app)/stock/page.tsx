import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { dealerScope, loadSettings, loadStockLocations } from '@/lib/pm/dealer/scope';
import { loadStock } from '@/lib/pm/dealer/unit-queries';
import { isAged } from '@/lib/pm/dealer/math';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { StockView, type AgeFilter, type StockGroup } from '@/components/dealer/stock/StockView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Stock' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUPS: ReadonlyArray<StockGroup> = ['all', 'stock', 'order', 'held', 'rental'];
const AGES: ReadonlyArray<AgeFilter> = ['all', '90', '180', '365'];

/** Whole goods: units on the lot, on order and held, with aging, cost and the floor-plan word from Merit Books. */
export default async function StockPage({ searchParams }: { searchParams: { unit?: string; new?: string; group?: string; age?: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  const { money: mv } = await guardPage('/stock');
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Stock" />
          <StoreOff title="Stock" what="Units received against manufacturer invoices, aged, priced and tracked against the floor plan." />
        </Page>
      </>
    );
  }
  const [list, locations, settings] = await Promise.all([
    loadStock(o.db, o.dealerIds),
    loadStockLocations(o.db, o.dealerIds),
    loadSettings(o.db, o.dealerIds),
  ]);
  const inStock = list.units.filter((u) => ['IN_STOCK', 'PDI', 'DEMO', 'ON_HOLD'].includes(u.unit_status));
  const aged = list.units.filter(isAged).length;
  const sot = list.units.filter((u) => u.sold_out_of_trust).length;
  const age = AGES.find((a) => a === searchParams.age) ?? 'all';
  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(inStock.length)} in stock`, strong: true },
          ...(mv.cost ? [{ label: `${money(inStock.reduce((s, u) => s + u.cost_cents, 0), { decimals: 0 })} at cost`, tnum: true }] : []),
          ...(aged ? [`${count(aged)} over 180 days`] : []),
          ...(sot ? [{ label: `${count(sot)} sold out of trust`, strong: true }] : []),
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title="Stock" actions={<ButtonLink variant="quiet" href="/stock/settings">Store settings</ButtonLink>} />
        <StockView
          units={list.units}
          vendors={list.vendors}
          photoCounts={list.photoCounts}
          stockLocations={locations}
          companies={o.dealerCompanies}
          settings={settings}
          writeCompanyId={o.writeCompanyId}
          multi={o.dealerIds.length > 1}
          today={todayIso()}
          capped={list.capped}
          focusId={searchParams.unit && UUID.test(searchParams.unit) ? searchParams.unit : null}
          openReceive={searchParams.new === '1'}
          initialGroup={GROUPS.find((g) => g === searchParams.group) ?? 'all'}
          initialAge={age}
        />
      </Page>
    </>
  );
}
