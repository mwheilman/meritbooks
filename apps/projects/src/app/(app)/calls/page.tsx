import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { CallDesk } from '@/components/fieldservice/calls/CallDesk';
import { NotSetUp, OneCompany } from '@/components/fieldservice/common/OneCompany';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadBookingSetup, loadCalls } from '@/lib/fieldservice/queries';
import { todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Calls' };
export const dynamic = 'force-dynamic';

/** The CSR's booking desk (FS-02/03/04/10/15): caller pop, scripted booking into capacity, requests inbox. */
export default async function CallsPage({ searchParams }: { searchParams: { phone?: string } }) {
  const g = await fsPage([['projects.dispatch', 'edit']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) {
    return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Calls" /><OneCompany what="Calls, capacity and arrival windows" /></Page></>);
  }
  const [setup, calls] = await Promise.all([loadBookingSetup(o.db, [companyId]), loadCalls(o.db, [companyId])]);
  const company = o.companyName(companyId) ?? o.where;
  if (!setup.jobTypes.length || !setup.businessUnits.length || !setup.windows.length) {
    return (<><PageLine facts={[company]} /><Page><PageHead eyebrow={company} title="Calls" /><NotSetUp what="Booking needs business units, arrival windows and bookable job types." canSeed={g.can('projects.settings', 'configure')} /></Page></>);
  }
  const today = todayIso();
  const bookedToday = calls.recent.filter((c) => c.status === 'BOOKED' && c.created_at.slice(0, 10) === today).length;
  const handledToday = calls.recent.filter((c) => (c.status === 'BOOKED' || c.status === 'NOT_BOOKED') && c.created_at.slice(0, 10) === today).length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(calls.requests.length)} requests waiting`, strong: calls.requests.length > 0 }, `${count(bookedToday)} of ${count(handledToday)} calls booked today`]} />
      <Page>
        <PageHead eyebrow={company} title="Calls" />
        <CallDesk
          companyId={companyId}
          companyName={company}
          today={today}
          setup={setup}
          recent={calls.recent}
          requests={calls.requests}
          canOverride={g.can('projects.dispatch', 'edit')}
          initialPhone={searchParams.phone && /^[\d()+\s-]{7,20}$/.test(searchParams.phone) ? searchParams.phone : null}
        />
      </Page>
    </>
  );
}
