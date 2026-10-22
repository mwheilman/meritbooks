import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count } from '@meritbooks/merit-ui';
import { dealerScope, loadSettings, loadStockLocations } from '@/lib/pm/dealer/scope';
import { loadOutbox } from '@/lib/pm/dealer/store-queries';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { StoreSettings } from '@/components/dealer/settings/StoreSettings';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Store settings' };
export const dynamic = 'force-dynamic';

/** Store rules (margin floor, payoff guard, approvals, tax estimate, stock locations) and the Merit Books connection. */
export default async function StoreSettingsPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/stock/settings');
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Store settings" />
          <StoreOff title="Store settings" what="The margin floor, floor-plan payoff guard, desk roles, delivery checklist, lots and parts rooms." />
        </Page>
      </>
    );
  }
  const [settings, locations, outbox] = await Promise.all([loadSettings(o.db, o.dealerIds), loadStockLocations(o.db, o.dealerIds), loadOutbox(o.db, o.dealerIds)]);
  const rejected = outbox.queue.filter((q) => q.status === 'REJECTED').length;
  const held = outbox.queue.filter((q) => q.status === 'HELD').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Stock', href: '/stock' }, { label: 'Store settings' }]} />
      <PageLine facts={[o.where, ...(rejected ? [{ label: `${count(rejected)} rejected by Merit Books`, strong: true }] : []), ...(held ? [`${count(held)} held for Merit Books`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Store settings" actions={<ButtonLink variant="quiet" href="/settings">All settings</ButtonLink>} />
        <StoreSettings
          companies={o.dealerCompanies}
          initialCompanyId={o.writeCompanyId ?? o.dealerIds[0]!}
          settings={settings}
          stockLocations={locations}
          outbox={outbox}
          booksPresent={o.scope.tenant.booksPresent}
        />
      </Page>
    </>
  );
}
