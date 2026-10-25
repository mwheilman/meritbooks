import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadInspections } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { InspectionsView } from '@/components/commercial/InspectionsView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Inspections' };

/** Inspections and QA / QC checklists (CGC-75). */
export default async function InspectionsPage({ searchParams }: { searchParams: { item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/inspections');
  const jobs = jobRefs(o);
  const data = await loadInspections(o.db, jobs.map((j) => j.id));
  const failedThisMonth = data.inspections.filter((i) => i.result === 'FAIL' || i.result === 'PARTIAL').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Inspections' }]} />
      <PageLine facts={[o.where, { label: `${count(data.inspections.filter((i) => i.status === 'IN_PROGRESS').length)} in progress`, strong: true }, `${count(failedThisMonth)} with failures`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Inspections" />
        <InspectionsView {...data} jobs={jobs} today={todayIso()} canEdit={holds(access, 'projects.jobs:edit', o.scope.company?.id ?? null)} initialId={searchParams.item ?? null} />
      </Page>
    </>
  );
}
