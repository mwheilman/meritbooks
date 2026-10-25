import type { Metadata } from 'next';
import { Page, PageHead, count, pct } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadBuyout } from '@/lib/commercial/screens';
import { buyoutSummary } from '@/lib/commercial/screen-logic';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { BuyoutBoard } from '@/components/commercial/BuyoutView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Buyout' };

/** The buyout log across jobs (CGC-30): budget vs bought by package, what is not bought and when it is needed. */
export default async function BuyoutPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/buyout');
  const jobs = jobRefs(o);
  const packages = await loadBuyout(o.db, jobs.map((j) => j.id));
  const s = buyoutSummary(packages);
  return (
    <>
      <PageCrumbs items={[{ label: 'Buyout' }]} />
      <PageLine facts={[o.where, { label: s.pctBought == null ? 'Nothing bought yet' : `${pct(s.pctBought)} bought out`, strong: true }, `${count(s.late)} past the need date`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Buyout" />
        <BuyoutBoard packages={packages} jobs={jobs} today={todayIso()} canEdit={!o.scope.readOnly && holds(access, 'projects.commitments:edit', o.scope.company?.id ?? null)} />
      </Page>
    </>
  );
}
