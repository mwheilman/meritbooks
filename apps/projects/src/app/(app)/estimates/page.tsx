import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { scopedJobs } from '@/lib/pm/scoped';
import { lower } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import { listEstimates } from '@/lib/pm/money/queries';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { EstimatesList, type EstimateListRow } from '@/components/money/EstimatesList';
import { guardPage } from '@/components/shell/page-guard';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Estimates' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).estimates };
}

/** Every estimate in scope by status (the latest version of each; superseded versions stay on the job). */
export default async function EstimatesPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { money: mv } = await guardPage('/estimates');
  const db = await requireDb();
  const [vocab, jobs, list] = await Promise.all([getVocabulary(db, scope.company?.id ?? null, scope.companyIds), scopedJobs(db, scope), listEstimates(db, { companyIds: scope.companyIds }, 2000)]);
  const rows: EstimateListRow[] = list.filter((e) => e.status !== 'SUPERSEDED' && jobs.byId.has(e.job_id)).map((e) => ({
    id: e.id, number: e.number, version: e.version, title: e.title, status: e.status, jobId: e.job_id, jobLabel: jobs.label(e.job_id) ?? 'Job', company: jobs.company(e.job_id),
    total: e.total_cents, cost: e.cost_total_cents, date: (e.accepted_at ?? e.declined_at ?? e.sent_at ?? e.created_at).slice(0, 10), validUntil: e.valid_until,
  }));
  const out = rows.filter((r) => r.status === 'SENT');
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageCrumbs items={[{ label: vocab.estimates }]} />
      <PageLine facts={[where, { label: mv.contract ? `${count(out.length)} with customers · ${money(out.reduce((s, r) => s + r.total, 0), { decimals: 0 })}` : `${count(out.length)} with customers`, strong: true, tnum: true }, `${count(rows.filter((r) => r.status === 'DRAFT').length)} drafts`]} />
      <Page>
        <PageHead eyebrow={where} title={vocab.estimates}>
          <p className="t-cap" style={{ marginTop: 4 }}>Start one from its job’s {vocab.estimate} tab; accepting it writes the original budget and the contract.</p>
        </PageHead>
        <EstimatesList rows={rows} today={todayIso()} showCompany={scope.companyIds.length > 1} />
      </Page>
    </>
  );
}
