import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs } from '@/lib/pm/ops/scope';
import { loadProduction } from '@/lib/pm/ops/production-queries';
import { shopLoad, weeksText } from '@/lib/pm/ops/shop-math';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { ProductionView, type ProductionTab } from '@/components/ops/production/ProductionView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Production' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProductionPage({ searchParams }: { searchParams: { view?: string; wo?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const data = await loadProduction(o.db, { companyIds: o.companyIds });
  if (!has(o, 'production') && data.orders.length === 0 && data.centers.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Production" />
          <ModuleOff title="Production" what="Engineer-to-order shop work: cut lists, routings, release checks and operations by work center." />
        </Page>
      </>
    );
  }
  const jobLabels: Record<string, string> = {};
  for (const r of data.orders) jobLabels[r.job_id] = o.jobs.label(r.job_id) ?? '';
  for (const f of data.floor) jobLabels[f.job_id] ??= o.jobs.label(f.job_id) ?? '';
  const load = shopLoad(data.load);
  const open = data.orders.filter((x) => x.status !== 'COMPLETE' && x.status !== 'CLOSED' && x.status !== 'CANCELLED').length;
  const late = data.orders.filter((x) => x.is_late).length;
  const view: ProductionTab = searchParams.view === 'floor' || searchParams.view === 'setup' ? searchParams.view : 'board';
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(open)} open orders`, strong: true }, ...(load.weeks != null ? [`${weeksText(load.weeks)} of shop backlog`] : []), ...(late ? [`${count(late)} late`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Production" />
        <ProductionView
          orders={data.orders}
          load={data.load}
          floor={data.floor}
          centers={data.centers}
          routings={data.routings}
          steps={data.steps}
          jobs={jobRefs(o)}
          jobLabels={jobLabels}
          companyId={o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null)}
          today={todayIso()}
          initialTab={view}
          focusId={searchParams.wo && UUID.test(searchParams.wo) ? searchParams.wo : null}
        />
      </Page>
    </>
  );
}
