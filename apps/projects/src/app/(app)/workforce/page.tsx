import type { Metadata } from 'next';
import { Page, PageHead, WidgetState, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadWorkforce } from '@/lib/commercial/screens';
import { mondayOf, weekStarts } from '@/lib/commercial/screen-logic';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { WorkforceView } from '@/components/commercial/WorkforceView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Workforce' };

/** Workforce planning across jobs (CGC-92): the board by person and week, crew requests, conflicts and the bench. */
export default async function WorkforcePage({ searchParams }: { searchParams: { company?: string; from?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/workforce');
  const today = todayIso();
  const companies = o.scope.company ? [{ id: o.scope.company.id, name: o.scope.company.name }] : o.companies;
  const companyId = companies.find((c) => c.id === searchParams.company)?.id ?? companies[0]?.id ?? null;
  const from = mondayOf(searchParams.from && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.from) ? searchParams.from : today);
  const weeks = weekStarts(from, 8);
  if (!companyId) {
    return <Page><WidgetState state={{ kind: 'empty', title: 'No company in view', body: 'Switch to a company with ⌘J to plan its crews.' }} /></Page>;
  }
  const data = await loadWorkforce(o.db, companyId, from);
  const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId);
  const open = data.requests.filter((r) => r.status === 'OPEN' || r.status === 'PARTIAL').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Workforce' }]} />
      <PageLine facts={[companies.find((c) => c.id === companyId)?.name ?? o.where, { label: `${count(open)} crew requests open`, strong: true }, `${count(data.conflicts.length)} conflicts`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Workforce" />
        <WorkforceView companyId={companyId} companies={companies} from={from} weeks={weeks} {...data} jobs={jobs} today={today}
          canAssign={holds(access, 'projects.dispatch:edit', companyId)} canRequest={holds(access, 'projects.jobs:edit', companyId)} />
      </Page>
    </>
  );
}
