import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has, customerNames } from '@/lib/pm/ops/scope';
import { loadAssets } from '@/lib/pm/ops/field-queries';
import { isDealerVocab } from '@/lib/pm/ops/labels';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { AssetsView } from '@/components/ops/assets/AssetsView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Equipment' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AssetsPage({ searchParams }: { searchParams: { asset?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/assets');
  const assets = await loadAssets(o.db, { companyIds: o.companyIds });
  if (!has(o, 'assets') && assets.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Equipment" />
          <ModuleOff title="Equipment" what="Customer equipment and dealer units by serial, with every service event in one history." />
        </Page>
      </>
    );
  }
  const today = todayIso();
  const customers = await customerNames(o.db, assets.map((a) => a.customer_id));
  const active = assets.filter((a) => a.status === 'ACTIVE');
  const warranty = active.filter((a) => a.warranty_expires_on && a.warranty_expires_on >= today).length;
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(active.length)} in service`, strong: true }, `${count(warranty)} under warranty`, `${count(new Set(active.map((a) => a.customer_id).filter(Boolean)).size)} customers`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Equipment" />
        <AssetsView
          assets={assets}
          customers={customers}
          companies={o.companies}
          defaultCompanyId={o.scope.company?.id ?? o.companies[0]?.id ?? null}
          today={today}
          focusId={searchParams.asset && UUID.test(searchParams.asset) ? searchParams.asset : null}
          dealer={isDealerVocab(o.vocab) || o.packKey === 'equipment_dealer'}
        />
      </Page>
    </>
  );
}
