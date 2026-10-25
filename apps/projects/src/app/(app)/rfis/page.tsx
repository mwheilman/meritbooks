import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadInbox, loadRfis } from '@/lib/commercial/server';
import type { InboxRow } from '@/lib/commercial/types';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { RfisView } from '@/components/commercial/RfisView';
import { BallInCourt } from '@/components/commercial/BallInCourt';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'RFIs' };

/** RFI log with due dates, ball in court and the official answer (CGC-64), plus what waits on the caller. */
export default async function RfisPage({ searchParams }: { searchParams: { item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/rfis');
  const jobs = jobRefs(o);
  const [rfis, inbox] = await Promise.all([
    loadRfis(o.db, jobs.map((j) => j.id)),
    loadInbox(o.db, o.scope.company?.id ?? null).catch((): InboxRow[] => []),
  ]);
  const today = todayIso();
  const open = rfis.filter((r) => r.status === 'OPEN');
  const late = open.filter((r) => r.due_on && r.due_on < today).length;
  return (
    <>
      <PageCrumbs items={[{ label: 'RFIs' }]} />
      <PageLine facts={[o.where, { label: `${count(open.length)} open`, strong: true }, `${count(late)} past due`]} />
      <Page>
        <PageHead eyebrow={o.where} title="RFIs" />
        <div className="stack" style={{ gap: 32 }}>
          <RfisView rfis={rfis} jobs={jobs} today={today} initialId={searchParams.item ?? null} />
          <BallInCourt items={inbox} today={today} jobLabels={Object.fromEntries(jobs.map((j) => [j.id, j.label]))} />
        </div>
      </Page>
    </>
  );
}
