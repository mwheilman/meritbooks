import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadCorrespondence } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { CorrespondenceView } from '@/components/commercial/CorrespondenceView';
import { awaitingResponse } from '@/lib/commercial/screen-logic';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Correspondence' };

/** Transmittals, letters and contract notices with response tracking (CGC-67). */
export default async function CorrespondencePage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/correspondence');
  const jobs = jobRefs(o);
  const data = await loadCorrespondence(o.db, jobs.map((j) => j.id));
  const today = todayIso();
  const waiting = data.letters.filter((l) => awaitingResponse(l)).length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Correspondence' }]} />
      <PageLine facts={[o.where, { label: `${count(waiting)} waiting on a response`, strong: true }, `${count(data.transmittals.filter((t) => t.status === 'SENT').length)} transmittals not acknowledged`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Correspondence" />
        <CorrespondenceView {...data} jobs={jobs} today={today} canEdit={holds(access, 'projects.documents:create', o.scope.company?.id ?? null)}
          initialJob={searchParams.job && jobs.some((j) => j.id === searchParams.job) ? searchParams.job : null} />
      </Page>
    </>
  );
}
