import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs, vendorNames } from '@/lib/pm/ops/scope';
import { loadCois, loadComplianceQueue, loadSubPayApps, loadWaivers } from '@/lib/commercial/server';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ComplianceView } from '@/components/commercial/ComplianceView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Compliance' };

const TABS = new Set(['holds', 'sub-pay-apps', 'waivers', 'insurance']);

/** Payment holds, sub pay applications, lien waivers and insurance (CGC-45..49). */
export default async function CompliancePage({ searchParams }: { searchParams: { tab?: string; item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/compliance');
  const jobs = jobRefs(o);
  const ids = jobs.map((j) => j.id);
  const [queue, apps, waivers] = await Promise.all([loadComplianceQueue(o.db, ids), loadSubPayApps(o.db, ids), loadWaivers(o.db, ids)]);
  const vendorIds = [...new Set([...queue.map((q) => q.vendor_id), ...apps.map((a) => a.vendor_id), ...waivers.map((w) => w.vendor_id)].filter((x): x is string => !!x))];
  const [cois, names] = await Promise.all([loadCois(o.db, vendorIds), vendorNames(o.db, vendorIds)]);
  const held = queue.filter((q) => q.payment_hold_effective).length;
  const tab = searchParams.tab && TABS.has(searchParams.tab) ? (searchParams.tab as 'holds' | 'sub-pay-apps' | 'waivers' | 'insurance') : 'holds';
  return (
    <>
      <PageCrumbs items={[{ label: 'Compliance' }]} />
      <PageLine facts={[o.where, { label: `${count(held)} payments on hold`, strong: true }, `${count(apps.filter((a) => a.status === 'SUBMITTED' || a.status === 'IN_REVIEW').length)} sub pay applications in review`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Subcontractor compliance" />
        <ComplianceView queue={queue} apps={apps} waivers={waivers} cois={cois} vendorNames={names} jobLabels={Object.fromEntries(jobs.map((j) => [j.id, j.label]))}
          companies={o.companies} activeCompanyId={o.scope.company?.id ?? null} today={todayIso()} initialTab={tab} initialItem={searchParams.item ?? null} />
      </Page>
    </>
  );
}
