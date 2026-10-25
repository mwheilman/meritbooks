import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs, jobTypesWith } from '@/lib/pm/ops/scope';
import { loadLogs } from '@/lib/pm/ops/records-queries';
import { employeeNames } from '@/lib/pm/people';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { lower } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { LogsView } from '@/components/ops/records/LogsView';
import { SiteRecords, type SiteLogRef, type TmTicketRef } from '@/components/commercial/SiteRecords';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Daily logs' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).daily_logs };
}

export default async function DailyLogsPage({ searchParams = {} }: { searchParams?: { tab?: string; item?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/daily-logs');
  const scopedIds = [...o.jobs.byId.keys()].slice(0, 400);
  const pmdb = o.db.schema('pm');
  const [logs, types, siteLogs, tickets] = await Promise.all([
    loadLogs(o.db, { companyIds: o.companyIds }, (id) => o.jobs.byId.has(id)),
    jobTypesWith(o.db, o.companyIds, 'daily_logs'),
    // the structured (commercial) log and T&M tickets, 1120; each read is the caller's own RLS
    scopedIds.length ? pmdb.from('cm_daily_logs').select('id, job_id, log_date, status, signed_by_name, amended_count').in('job_id', scopedIds).order('log_date', { ascending: false }).limit(60) : Promise.resolve({ data: [], error: null }),
    scopedIds.length ? pmdb.from('cm_tm_tickets').select('id, job_id, number, work_date, description, status, signer_name, signed_at, disputed_reason, change_event_id, billed_request_id').in('job_id', scopedIds).neq('status', 'VOID').order('work_date', { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null }),
  ]);
  if (!has(o, 'daily_logs') && logs.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title={o.vocab.daily_logs} />
          <ModuleOff title={o.vocab.daily_logs} what="The record of each day on site: crew, hours, weather and what happened." />
        </Page>
      </>
    );
  }
  const today = todayIso();
  const typeKeys = new Set(types.map((t) => `${t.companyId}:${t.key}`));
  const jobs = jobRefs(o);
  const logged = jobs.filter((j) => j.open && typeKeys.has(`${j.companyId}:${j.jobTypeKey}`)).map((j) => j.id);
  const names = await employeeNames(o.db, logs.map((l) => l.created_by));
  const todayCount = logs.filter((l) => l.log_date === today).length;
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(todayCount)} logged today`, strong: true }, `${count(Math.max(0, logged.length - new Set(logs.filter((l) => l.log_date === today).map((l) => l.job_id)).size))} open ${lower(o.vocab.jobs)} not logged`]} />
      <Page>
        <PageHead eyebrow={o.where} title={o.vocab.daily_logs} />
        <div className="stack" style={{ gap: 32 }}>
          <LogsView logs={logs} jobs={jobs} loggedJobIds={logged} today={today} meUserId={o.scope.userId} names={names} />
          <SiteRecords logs={(siteLogs.data ?? []) as SiteLogRef[]} tickets={(tickets.data ?? []) as TmTicketRef[]} jobs={jobs} today={today}
            initialTab={searchParams.tab === 'tm' ? 'tm' : 'logs'} initialItem={searchParams.item ?? null} />
        </div>
      </Page>
    </>
  );
}
