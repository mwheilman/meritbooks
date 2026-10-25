import type { Metadata } from 'next';
import { Page, PageHead, money } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { cmRpc, loadAuditCompany, loadForecasts, loadWip } from '@/lib/commercial/server';
import type { AuditFinding } from '@/lib/commercial/types';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { WipView, type ExecutiveSummary, type WipCompanyRows } from '@/components/commercial/WipView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'WIP' };

/** Month-ends, newest first: the last 12 plus the current month. Pure. */
function monthEnds(today: string, n = 13): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - i, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  const cur = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [cur, ...out.filter((x) => x !== cur)].slice(0, n);
}

const TABS = new Set(['schedule', 'eac', 'audit', 'summary']);

/** WIP (CFMA), monthly cost forecasts, billing auditor and the executive roll-up (CGC-28, CGC-53..55, CGC-110, CGC-111). */
export default async function WipPage({ searchParams }: { searchParams: { period?: string; tab?: string; item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/wip');
  const today = todayIso();
  const periods = monthEnds(today);
  const periodEnd = searchParams.period && periods.includes(searchParams.period) ? searchParams.period : periods[1] ?? periods[0]!;
  const jobs = jobRefs(o);
  const companies = o.scope.company ? [{ id: o.scope.company.id, name: o.scope.company.name }] : o.companies;
  const [wip, forecasts, audits, summary] = await Promise.all([
    Promise.all(companies.map(async (c): Promise<WipCompanyRows> => {
      try {
        return { companyId: c.id, companyName: c.name, rows: await loadWip(o.db, c.id, periodEnd), error: null };
      } catch (e) {
        return { companyId: c.id, companyName: c.name, rows: [], error: e instanceof Error ? e.message : 'WIP did not load.' };
      }
    })),
    loadForecasts(o.db, jobs.map((j) => j.id), periodEnd),
    Promise.all(companies.map((c) => loadAuditCompany(o.db, c.id).catch((): AuditFinding[] => []))),
    cmRpc<ExecutiveSummary>(o.db, 'cm_executive_summary', { p_location: o.scope.company?.id ?? null }).catch(() => null),
  ]);
  const rows = wip.flatMap((c) => c.rows);
  const net = rows.reduce((s, r) => s + Number(r.over_billed_cents ?? 0) - Number(r.under_billed_cents ?? 0), 0);
  const tab = searchParams.tab && TABS.has(searchParams.tab) ? (searchParams.tab as 'schedule' | 'eac' | 'audit' | 'summary') : 'schedule';
  return (
    <>
      <PageCrumbs items={[{ label: 'WIP' }]} />
      <PageLine facts={[o.where, { label: `Period ending ${periodEnd}`, strong: true }, { label: `${money(net, { decimals: 0 })} net ${net >= 0 ? 'over' : 'under'} billed`, tnum: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Work in progress" />
        <WipView companies={wip} forecasts={forecasts} audit={audits.flat()} summary={summary} periodEnd={periodEnd} periods={periods} today={today}
          jobLabels={Object.fromEntries(jobs.map((j) => [j.id, j.label]))} initialTab={tab} initialForecast={searchParams.item ?? null} />
      </Page>
    </>
  );
}
