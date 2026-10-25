import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { TimesheetReview } from '@/components/fieldservice/time/TimesheetReview';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { TimesheetDay } from '@/lib/fieldservice/completion-types';
import { todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Timesheet review' };
export const dynamic = 'force-dynamic';

/** Monday of the week holding `iso` (YYYY-MM-DD), moved back `weeksBack` weeks. */
function weekStart(iso: string, weeksBack: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow - 7 * weeksBack);
  return d.toISOString().slice(0, 10);
}

/** Timesheet review with exception flags (FS-102). */
export default async function TimesheetsPage({ searchParams }: { searchParams: { weeks?: string } }) {
  const g = await fsPage([['projects.time', 'approve']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Timesheet review" /><OneCompany what="Timesheet review" /></Page></>);
  const to = todayIso();
  const from = weekStart(to, searchParams.weeks === '2' ? 1 : 0);
  const r = await rpcLoad<TimesheetDay[]>(o.db, 'fs_timesheet_exceptions', { p_location: companyId, p_from: from, p_to: to, p_long_drive_minutes: 60, p_gap_minutes: 45 }, []);
  const company = o.companyName(companyId) ?? o.where;
  const flagged = r.data.filter((d) => !d.clean).length;
  const waiting = r.data.reduce((n, d) => n + d.submitted_ids.length, 0);
  return (
    <>
      <PageLine facts={[company, `${from} to ${to}`, { label: `${count(flagged)} days with exceptions`, strong: flagged > 0 }, `${count(waiting)} entries waiting`]} />
      <Page>
        <PageHead eyebrow={company} title="Timesheet review" />
        <TimesheetReview days={r.data} error={r.error} from={from} to={to} canApprove={g.can('projects.time', 'approve')} />
      </Page>
    </>
  );
}
