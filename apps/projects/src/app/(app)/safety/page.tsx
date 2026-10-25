import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadObservations, loadSafety } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { SafetyView } from '@/components/commercial/SafetyView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Safety' };

const TABS = new Set(['talks', 'jha', 'incidents', 'osha']);

/** Toolbox talks, pre-task plans, incidents and the OSHA logs (CGC-78, CGC-79). Injury detail needs projects.team:view. */
export default async function SafetyPage({ searchParams }: { searchParams: { tab?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/safety');
  const jobs = jobRefs(o);
  const ids = jobs.map((j) => j.id);
  const [data, obs] = await Promise.all([loadSafety(o.db, ids, (companyId) => holds(access, 'projects.team:edit', companyId)), loadObservations(o.db, ids)]);
  const company = o.scope.company?.id ?? null;
  const seesIncidents = data.incidentsVisible && holds(access, 'projects.team:view', company);
  const hazards = obs.filter((x) => x.obs_type === 'SAFETY' && (x.status === 'OPEN' || x.status === 'IN_PROGRESS')).map((x) => x.hazard ?? x.title);
  const today = todayIso();
  const tab = searchParams.tab && TABS.has(searchParams.tab) ? (searchParams.tab as 'talks' | 'jha' | 'incidents' | 'osha') : 'talks';
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  return (
    <>
      <PageCrumbs items={[{ label: 'Safety' }]} />
      <PageLine facts={[o.where, { label: `${count(data.talks.filter((t) => t.held_on >= weekAgo).length)} toolbox talks this week`, strong: true }, ...(seesIncidents ? [`${count(data.incidents.filter((i) => i.status !== 'CLOSED').length)} open incidents`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Safety" />
        <SafetyView talks={data.talks} jhas={data.jhas} incidents={seesIncidents ? data.incidents : []} incidentsVisible={seesIncidents} hazards={hazards} jobs={jobs}
          companies={o.scope.company ? [{ id: o.scope.company.id, name: o.scope.company.name }] : o.companies} today={today} initialTab={!seesIncidents && (tab === 'incidents' || tab === 'osha') ? 'talks' : tab}
          canRecord={holds(access, 'projects.documents:create', company)} canIncident={holds(access, 'projects.jobs:edit', company)} />
      </Page>
    </>
  );
}
