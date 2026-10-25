import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadCloseout } from '@/lib/commercial/screens';
import { CLOSEOUT_DONE } from '@/lib/commercial/screen-logic';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { CloseoutBoard } from '@/components/commercial/CloseoutView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Closeout' };

/** Closeout packages and the job close gate (CGC-103, CGC-106). */
export default async function CloseoutPage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/closeout');
  const jobs = jobRefs(o);
  const { items } = await loadCloseout(o.db, jobs.map((j) => j.id));
  const job = jobs.find((j) => j.id === searchParams.job) ?? null;
  const company = job?.companyId ?? o.scope.company?.id ?? null;
  const outstanding = items.filter((i) => i.required && !CLOSEOUT_DONE.has(i.status)).length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Closeout', href: '/closeout' }, ...(job ? [{ label: job.label }] : [])]} />
      <PageLine facts={[job?.label ?? o.where, { label: `${count(outstanding)} closeout documents outstanding`, strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Closeout" />
        <CloseoutBoard jobs={jobs} items={items} jobId={job?.id ?? null} today={todayIso()}
          canEdit={holds(access, 'projects.jobs:edit', company)} canClose={holds(access, 'projects.settings:configure', company)} />
      </Page>
    </>
  );
}
