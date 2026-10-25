import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadSpecs } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { SpecsView } from '@/components/commercial/SpecsView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Specifications' };

/** The project manual by section (CGC-62). */
export default async function SpecificationsPage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/specifications');
  const jobs = jobRefs(o);
  const data = await loadSpecs(o.db, jobs.map((j) => j.id));
  const initialJob = searchParams.job && jobs.some((j) => j.id === searchParams.job) ? searchParams.job : null;
  return (
    <>
      <PageCrumbs items={[{ label: 'Specifications' }]} />
      <PageLine facts={[o.where, { label: `${count(data.sections.length)} sections`, strong: true }, `${count(data.sections.filter((s) => s.revision > 0).length)} revised by addendum`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Specifications" />
        <SpecsView {...data} jobs={jobs} today={todayIso()} initialJob={initialJob} canEdit={holds(access, 'projects.documents:create', o.scope.company?.id ?? null)} />
      </Page>
    </>
  );
}
