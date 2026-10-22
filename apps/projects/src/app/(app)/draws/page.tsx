import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs } from '@/lib/pm/ops/scope';
import { loadDraws } from '@/lib/pm/ops/development-queries';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { DrawsView } from '@/components/ops/draws/DrawsView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Draws' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).draws };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DrawsPage({ searchParams }: { searchParams: { loan?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/draws');
  const data = await loadDraws(o.db, { companyIds: o.companyIds });
  if (!has(o, 'lender_draws') && data.status.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title={o.vocab.draws} />
          <ModuleOff title={o.vocab.draws} what="Construction loan budgets, the continuation sheet, inspections and the in-balance test after every draw." />
        </Page>
      </>
    );
  }
  const active = data.status.filter((s) => s.status === 'ACTIVE');
  const outOfBalance = active.filter((s) => s.in_balance_gap_cents > 0).length;
  const inFlight = data.draws.filter((d) => ['SUBMITTED', 'INSPECTION', 'APPROVED'].includes(d.status));
  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(active.length)} active ${active.length === 1 ? 'loan' : 'loans'}`, strong: true },
          ...(inFlight.length ? [{ label: `${money(inFlight.reduce((s, d) => s + (d.requested_cents ?? 0), 0))} with lenders`, tnum: true }] : []),
          ...(outOfBalance ? [`${count(outOfBalance)} out of balance`] : []),
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title={o.vocab.draws} />
        <DrawsView {...data} jobs={jobRefs(o)} today={todayIso()} initialScheduleId={searchParams.loan && UUID.test(searchParams.loan) ? searchParams.loan : null} />
      </Page>
    </>
  );
}
