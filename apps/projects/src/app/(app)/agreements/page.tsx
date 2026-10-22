import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs, customerNames } from '@/lib/pm/ops/scope';
import { loadAgreements } from '@/lib/pm/ops/field-queries';
import { rows } from '@/lib/pm/db';
import { ASSET_COLS, type AssetRow } from '@/lib/pm/ops/types';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { AgreementsView } from '@/components/ops/agreements/AgreementsView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Agreements' };
export const dynamic = 'force-dynamic';

export default async function AgreementsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { money: mv } = await guardPage('/agreements');
  const data = await loadAgreements(o.db, { companyIds: o.companyIds });
  if (!has(o, 'service_agreements') && data.agreements.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Agreements" />
          <ModuleOff title="Agreements" what="Memberships and maintenance agreements: term, visits owed, renewals and covered equipment." />
        </Page>
      </>
    );
  }
  const assetIds = [...new Set(data.coveredAssets.map((c) => c.asset_id))];
  const [customers, assets] = await Promise.all([
    customerNames(o.db, data.agreements.map((a) => a.customer_id)),
    assetIds.length ? rows<AssetRow>(await o.db.schema('pm').from('assets').select(ASSET_COLS).in('id', assetIds.slice(0, 500)), 'covered equipment') : Promise.resolve([] as AssetRow[]),
  ]);
  const assetLabels = Object.fromEntries(assets.map((a) => [a.id, [a.make, a.model, a.serial_number ? `#${a.serial_number}` : null].filter(Boolean).join(' ') || a.description || 'Equipment']));
  const today = todayIso();
  const active = data.agreements.filter((a) => a.status === 'ACTIVE');
  const overdue = data.visits.filter((x) => (x.status === 'NEW' || x.status === 'ON_HOLD') && (x.due_by ?? x.due_on ?? '9999') < today).length;

  return (
    <>
      <PageLine facts={[o.where, { label: `${count(active.length)} active`, strong: true }, ...(overdue ? [`${count(overdue)} visits overdue`] : []), ...(mv.contract ? [{ label: `${money(active.reduce((s, a) => s + a.price_cents, 0))} per billing period`, tnum: true }] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Agreements" />
        <AgreementsView agreements={data.agreements} visits={data.visits} coveredAssets={data.coveredAssets} assetLabels={assetLabels} customers={customers} jobs={jobRefs(o)} today={today} />
      </Page>
    </>
  );
}
