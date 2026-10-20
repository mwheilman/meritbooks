import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadSelectionBundle } from '@/lib/pm/ops/selection-load';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { lower } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { SelectionsView, type SelectionsTabKey } from '@/components/ops/selections/SelectionsView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Selections' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).selections };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SelectionsPage({ searchParams }: { searchParams: { tab?: string; job?: string; selection?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const b = await loadSelectionBundle(o.db, { companyIds: o.companyIds }, { modules: o.modules, packKeys: Object.values(o.packByCompany), inScope: (id) => o.jobs.byId.has(id) });
  if (b.tabs.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title={o.vocab.selections} />
          <ModuleOff title={o.vocab.selections} what="Client choices against allowances with dated, named approvals; purchasing with markup; flooring measures." />
        </Page>
      </>
    );
  }
  const today = todayIso();
  const waiting = b.selections.filter((s) => s.status === 'OPEN' || s.status === 'PROPOSED' || s.status === 'REJECTED');
  const overdue = waiting.filter((s) => s.is_overdue).length;
  const variance = b.selections.filter((s) => s.status === 'APPROVED').reduce((s, r) => s + (r.variance_cents ?? 0), 0);
  const requested = searchParams.tab as SelectionsTabKey | undefined;
  const tab = requested && b.tabs.includes(requested) ? requested : b.tabs[0]!;

  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(waiting.length)} waiting on clients`, strong: true },
          ...(overdue ? [`${count(overdue)} past due`] : []),
          { label: `${money(variance)} approved variance to allowances`, tnum: true },
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title={o.vocab.selections}>
          <p className="t-cap" style={{ marginTop: 4 }}>Every approval records who, how and when. Over-allowance amounts are billed as an allowance overage or a {lower(o.vocab.change_order)}.</p>
        </PageHead>
        <SelectionsView
          tabs={b.tabs}
          initialTab={tab}
          selections={b.selections}
          procurement={b.procurement}
          measures={b.measures}
          areas={b.areas}
          totals={b.totals}
          jobs={jobRefs(o)}
          vendors={b.vendors}
          storage={b.storage}
          today={today}
          initialJobId={searchParams.job && UUID.test(searchParams.job) ? searchParams.job : null}
          focusId={searchParams.selection && UUID.test(searchParams.selection) ? searchParams.selection : null}
        />
      </Page>
    </>
  );
}
