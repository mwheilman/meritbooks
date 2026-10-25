import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadSubmittals } from '@/lib/commercial/server';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { SubmittalsView } from '@/components/commercial/SubmittalsView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Submittals' };

/** Submittal register with submit-by dates from lead times, the review path and fabrication release (CGC-62, CGC-65, CGC-66). */
export default async function SubmittalsPage({ searchParams }: { searchParams: { item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/submittals');
  const jobs = jobRefs(o);
  const submittals = await loadSubmittals(o.db, jobs.map((j) => j.id));
  const today = todayIso();
  const toSubmit = submittals.filter((s) => s.status === 'NOT_STARTED' || s.status === 'REQUESTED' || s.status === 'REVISE_RESUBMIT');
  const late = toSubmit.filter((s) => s.submit_by && s.submit_by < today).length;
  const longLead = submittals.filter((s) => s.long_lead && !s.released_for_fab_on).length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Submittals' }]} />
      <PageLine facts={[o.where, { label: `${count(late)} past submit-by`, strong: true }, `${count(toSubmit.length)} to submit`, `${count(longLead)} long-lead not released`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Submittals" />
        <SubmittalsView submittals={submittals} jobs={jobs} today={today} initialId={searchParams.item ?? null} />
      </Page>
    </>
  );
}
