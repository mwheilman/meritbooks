import type { Metadata } from 'next';
import { isDealerVocab } from '@/lib/pm/ops/labels';
import { ButtonLink, Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs, jobTypesWith, customerNames } from '@/lib/pm/ops/scope';
import { loadTechSetup, loadWorkOrders } from '@/lib/pm/ops/field-queries';
import { claimOutstanding, woBand, woVocab, type WoBand } from '@/lib/pm/ops/labels';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { APP_TZ, todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { WorkOrderQueue } from '@/components/ops/work-orders/WorkOrderQueue';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Work orders' };
  return { title: woVocab(await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).many };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BANDS: ReadonlyArray<WoBand> = ['new', 'scheduled', 'progress', 'complete', 'closed'];

export default async function WorkOrdersPage({ searchParams }: { searchParams: { wo?: string; new?: string; band?: string; view?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { money: mv } = await guardPage('/work-orders');
  const wv = woVocab(o.vocab);
  const [list, setup, jobTypes] = await Promise.all([
    loadWorkOrders(o.db, { companyIds: o.companyIds }),
    loadTechSetup(o.db, { companyIds: o.companyIds }),
    jobTypesWith(o.db, o.companyIds, 'dispatch'),
  ]);
  if (!has(o, 'dispatch') && list.orders.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title={wv.many} />
          <ModuleOff title={wv.many} what="Dispatchable visits and repair orders with price-book lines, good-better-best options and sign-off." />
        </Page>
      </>
    );
  }
  const customers = await customerNames(o.db, [...list.claims.map((c) => c.payer_customer_id), ...list.orders.map((w) => w.payer_customer_id)]);
  const employees = Object.fromEntries(setup.employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]));
  const today = todayIso();
  const open = list.orders.filter((w) => ['new', 'scheduled', 'progress'].includes(woBand(w.status))).length;
  const complete = list.orders.filter((w) => w.status === 'COMPLETE').length;
  const outstanding = list.claims.reduce((s, c) => s + claimOutstanding(c), 0);
  const band = BANDS.find((b) => b === searchParams.band) ?? null;

  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(open)} open`, strong: true },
          ...(complete ? [`${count(complete)} complete, not closed`] : []),
          ...(outstanding && mv.contract ? [{ label: `${money(outstanding)} warranty outstanding`, tnum: true }] : []),
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title={wv.many} actions={isDealerVocab(o.vocab) ? <ButtonLink variant="quiet" href="/work-orders/tech-board">Tech board</ButtonLink> : undefined} />
        <WorkOrderQueue
          orders={list.orders}
          assignments={list.assignments}
          claims={list.claims}
          assets={list.assets}
          employees={employees}
          jobs={jobRefs(o)}
          jobTypes={jobTypes}
          companies={o.companies}
          defaultCompanyId={o.scope.company?.id ?? o.companies[0]?.id ?? null}
          packKey={o.packKey}
          skills={setup.skills}
          customers={customers}
          tz={APP_TZ}
          today={today}
          capped={list.capped}
          focusId={searchParams.wo && UUID.test(searchParams.wo) ? searchParams.wo : null}
          openNew={searchParams.new === '1'}
          initialBand={band}
          initialView={searchParams.view === 'claims' ? 'claims' : 'orders'}
        />
      </Page>
    </>
  );
}
