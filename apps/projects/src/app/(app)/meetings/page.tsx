import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadMeetings } from '@/lib/commercial/server';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { MeetingsView } from '@/components/commercial/MeetingsView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Meetings' };

/** Meeting series per job with items that carry forward until closed (CGC-68). */
export default async function MeetingsPage({ searchParams }: { searchParams: { item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/meetings');
  const jobs = jobRefs(o);
  const { meetings, items } = await loadMeetings(o.db, jobs.map((j) => j.id));
  const today = todayIso();
  const open = items.filter((i) => i.status === 'OPEN');
  const upcoming = meetings.filter((m) => m.status === 'SCHEDULED' && m.scheduled_at && m.scheduled_at.slice(0, 10) >= today).length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Meetings' }]} />
      <PageLine facts={[o.where, { label: `${count(open.length)} open items`, strong: true }, `${count(upcoming)} meetings coming up`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Meetings" />
        <MeetingsView meetings={meetings} items={items} jobs={jobs} today={today} initialId={searchParams.item ?? null} />
      </Page>
    </>
  );
}
