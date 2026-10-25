import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead, shortDate } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { loadDailyLog } from '@/lib/commercial/server';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { DailyLogView } from '@/components/commercial/DailyLogView';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Daily log' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One structured daily log (CGC-70, CGC-71): manpower by company, delays, deliveries, inspections, voice entry, sign and amend. */
export default async function DailyLogPage({ params }: { params: { logId: string } }) {
  if (!UUID.test(params.logId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/daily-logs');
  const { log, entries } = await loadDailyLog(o.db, params.logId);
  if (!log) notFound();
  const dir = await o.db.schema('pm').from('cm_v_project_directory').select('vendor_id, company_name, trade').eq('job_id', log.job_id).limit(200);
  const directory = ((dir.data ?? []) as Array<{ vendor_id: string | null; company_name: string | null; trade: string | null }>)
    .filter((d) => d.company_name).map((d) => ({ vendorId: d.vendor_id, name: d.company_name!, trade: d.trade }));
  const jobLabel = o.jobs.label(log.job_id) ?? 'Job';
  const today = todayIso();
  return (
    <>
      <PageCrumbs items={[{ label: o.vocab.daily_logs, href: '/daily-logs' }, { label: shortDate(log.log_date, today) }]} />
      <PageLine facts={[o.where, { label: jobLabel, strong: true }, log.log_date === today ? 'Today' : shortDate(log.log_date, today)]} />
      <Page>
        <PageHead eyebrow={jobLabel} title={`Daily log · ${shortDate(log.log_date, today)}`} />
        <DailyLogView log={log} entries={entries} jobLabel={jobLabel} jobId={log.job_id} directory={directory} />
      </Page>
    </>
  );
}
