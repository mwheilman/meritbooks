import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadChangeBoard } from '@/lib/commercial/server';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ChangeEventsView } from '@/components/commercial/ChangeEventsView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Change events' };

/** Change events → RFQs → PCOs / CORs → owner change orders → subcontract changes, with the exposure line (CGC-32..37). */
export default async function ChangeEventsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { money } = await guardPage('/change-events');
  const jobs = jobRefs(o);
  const jobIds = jobs.map((j) => j.id);
  const pm = o.db.schema('pm');
  const [board, vendors, commitments] = await Promise.all([
    loadChangeBoard(o.db, jobIds, { contract: money.contract, cost: money.cost }),
    money.cost ? pm.from('v_core_vendors_masked').select('id, name, display_name').order('name').limit(500) : Promise.resolve({ data: [], error: null }),
    money.cost && jobIds.length
      ? pm.from('commitments').select('id, number, vendor_id, job_id').in('job_id', jobIds.slice(0, 400)).in('status', ['APPROVED', 'EXECUTED']).eq('commitment_type', 'SUBCONTRACT').limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const open = board.events.filter((e) => e.status === 'OPEN' || e.status === 'PRICING' || e.status === 'PRICED').length;
  const proceeding = board.events.filter((e) => e.proceeding && e.status !== 'APPROVED' && e.status !== 'VOID').length;
  return (
    <>
      <PageCrumbs items={[{ label: 'Change events' }]} />
      <PageLine facts={[o.where, { label: `${count(open)} open`, strong: true }, `${count(proceeding)} proceeding without a price`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Change events" />
        <ChangeEventsView
          events={board.events} pcos={board.pcos} rfqs={board.rfqs} exposure={board.exposure} jobs={jobs} today={todayIso()}
          vendors={((vendors.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name }))}
          commitments={((commitments.data ?? []) as Array<{ id: string; number: string | null; vendor_id: string | null; job_id: string }>).map((c) => ({ id: c.id, number: c.number, vendorId: c.vendor_id, jobId: c.job_id }))}
        />
      </Page>
    </>
  );
}
