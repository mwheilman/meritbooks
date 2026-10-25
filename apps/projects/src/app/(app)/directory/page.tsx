import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadDirectory } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { DirectoryView } from '@/components/commercial/DirectoryView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Directory' };

/** Project directory with trade data on the shared master (CGC-04). */
export default async function DirectoryPage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/directory');
  const jobs = jobRefs(o);
  const data = await loadDirectory(o.db, jobs.map((j) => j.id));
  const company = o.scope.company?.id ?? null;
  const initialJob = searchParams.job && jobs.some((j) => j.id === searchParams.job) ? searchParams.job : null;
  return (
    <>
      <PageCrumbs items={[{ label: 'Directory' }]} />
      <PageLine facts={[o.where, { label: `${count(data.entries.length)} on job directories`, strong: true }, `${count(data.profiles.length)} companies with trade data`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Directory" />
        <DirectoryView {...data} jobs={jobs} today={todayIso()} initialJob={initialJob}
          canEdit={holds(access, 'projects.jobs:edit', company)} canEditProfiles={holds(access, 'projects.commitments:edit', company)} />
      </Page>
    </>
  );
}
