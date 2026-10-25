import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ButtonLink, Page, PageHead, count } from '@meritbooks/merit-ui';
import { dealerScope, loadSettings, loadStockLocations } from '@/lib/pm/dealer/scope';
import { loadCatalog, loadCounts, loadPartsOrders, loadSpecialOrders, loadTickets } from '@/lib/pm/dealer/parts-queries';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { PARTS_TABS, PartsTabs, type PartsTab } from '@/components/dealer/parts/PartsTabs';
import { CounterView } from '@/components/dealer/parts/CounterView';
import { CatalogView } from '@/components/dealer/parts/CatalogView';
import { SpecialOrdersView } from '@/components/dealer/parts/SpecialOrdersView';
import { PartsOrdersView } from '@/components/dealer/parts/PartsOrdersView';
import { CountsView } from '@/components/dealer/parts/CountsView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Parts' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parts department: counter, catalog and on hand, special orders, OEM stock orders, physical counts. */
export default async function PartsPage({ searchParams }: { searchParams: { tab?: string; ticket?: string; new?: string; below?: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/parts');
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Parts" />
          <StoreOff title="The parts department" what="A fast counter with supersession, bins and min/max, special orders, OEM stock orders and physical counts." />
        </Page>
      </>
    );
  }
  const tab: PartsTab = PARTS_TABS.find((t) => t.value === searchParams.tab)?.value ?? (searchParams.below === '1' ? 'catalog' : 'counter');
  const ids = o.writeCompanyId ? [o.writeCompanyId] : o.dealerIds;
  const [locations, settings, badge] = await Promise.all([
    loadStockLocations(o.db, o.dealerIds),
    loadSettings(o.db, o.dealerIds),
    Promise.all([
      o.db.schema('pm').from('parts_special_orders').select('id', { count: 'exact', head: true }).in('location_id', o.dealerIds).eq('status', 'RECEIVED'),
      o.db.schema('pm').from('v_parts_on_hand').select('part_id', { count: 'exact', head: true }).in('location_id', o.dealerIds).eq('below_min', true),
      o.db.schema('pm').from('parts_tickets').select('id', { count: 'exact', head: true }).in('location_id', o.dealerIds).eq('status', 'OPEN'),
    ]),
  ]);
  const [soIn, belowMin, openTickets] = badge.map((r) => r.count ?? 0) as [number, number, number];
  const s = o.writeCompanyId ? settings[o.writeCompanyId] : null;
  const myLocations = locations.filter((l) => l.is_active && (!o.writeCompanyId || l.location_id === o.writeCompanyId));
  const today = todayIso();

  let body: ReactNode;
  if (tab === 'counter') {
    const t = await loadTickets(o.db, ids);
    body = (
      <CounterView
        companyId={o.writeCompanyId}
        stockLocations={myLocations}
        defaultStockLocationId={s?.parts_stock_location_id ?? null}
        allowNegative={s?.allow_negative_parts ?? false}
        defaultTaxRate={s?.default_tax_rate ?? null}
        tickets={t.tickets}
        customers={t.customers}
        focusTicketId={searchParams.ticket && UUID.test(searchParams.ticket) && t.tickets.some((x) => x.id === searchParams.ticket && x.status === 'OPEN') ? searchParams.ticket : null}
        today={today}
      />
    );
  } else if (tab === 'catalog') {
    const c = await loadCatalog(o.db, ids);
    body = <CatalogView parts={c.parts} onHand={c.onHand} vendors={c.vendors} stockLocations={locations} companyId={o.writeCompanyId} capped={c.capped} newNumber={searchParams.new ? searchParams.new.slice(0, 40) : null} initialFilter={searchParams.below === '1' ? 'below' : 'all'} />;
  } else if (tab === 'special') {
    body = <SpecialOrdersView data={await loadSpecialOrders(o.db, ids)} stockLocations={myLocations} defaultStockLocationId={s?.parts_stock_location_id ?? null} today={today} />;
  } else if (tab === 'orders') {
    body = <PartsOrdersView data={await loadPartsOrders(o.db, ids)} stockLocations={locations} defaultStockLocationId={s?.parts_stock_location_id ?? null} companyId={o.writeCompanyId} today={today} />;
  } else {
    body = <CountsView data={await loadCounts(o.db, ids)} stockLocations={myLocations} canWrite={!!o.writeCompanyId} today={today} />;
  }

  return (
    <>
      <PageLine facts={[o.where, ...(openTickets ? [{ label: `${count(openTickets)} open tickets`, strong: true }] : []), ...(belowMin ? [`${count(belowMin)} below minimum`] : []), ...(soIn ? [`${count(soIn)} special orders in`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Parts" actions={<><ButtonLink variant="quiet" href="/parts/counter">Scan counter</ButtonLink><ButtonLink variant="quiet" href="/parts/price-files">Price files</ButtonLink><ButtonLink variant="quiet" href="/stock/settings">Store settings</ButtonLink></>} />
        <div className="stack">
          <PartsTabs value={tab} counts={{ counter: openTickets, catalog: belowMin, special: soIn }} />
          {body}
        </div>
      </Page>
    </>
  );
}
