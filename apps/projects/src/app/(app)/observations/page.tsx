import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadObservations } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ObservationsView } from '@/components/commercial/ObservationsView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Observations' };

/** Quality, safety and commissioning observations (CGC-76). */
export default async function ObservationsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/observations');
  const jobs = jobRefs(o);
  const today = todayIso();
  const [observations, vendors] = await Promise.all([
    loadObservations(o.db, jobs.map((j) => j.id)),
    o.db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').order('name').limit(1000),
  ]);
  const company = o.scope.company?.id ?? null;
  const open = observations.filter((x) => x.status === 'OPEN' || x.status === 'IN_PROGRESS');
  return (
    <>
      <PageCrumbs items={[{ label: 'Observations' }]} />
      <PageLine facts={[o.where, { label: `${count(open.length)} open`, strong: true }, `${count(open.filter((x) => x.due_on && x.due_on < today).length)} past due`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Observations" />
        <ObservationsView observations={observations} jobs={jobs} today={today}
          vendors={((vendors.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name }))}
          canEdit={holds(access, 'projects.jobs:edit', company)} canChange={holds(access, 'projects.jobs:edit', company)} />
      </Page>
    </>
  );
}
