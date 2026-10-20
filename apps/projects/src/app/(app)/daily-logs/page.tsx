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
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Daily logs' };
  return { title: (await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds)).daily_logs };
}

export default async function DailyLogsPage() {
  const o = await opsScope();
  if (!o) return null;
  const [logs, types] = await Promise.all([loadLogs(o.db, { companyIds: o.companyIds }, (id) => o.jobs.byId.has(id)), jobTypesWith(o.db, o.companyIds, 'daily_logs')]);
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
        <LogsView logs={logs} jobs={jobs} loggedJobIds={logged} today={today} meUserId={o.scope.userId} names={names} />
      </Page>
    </>
  );
}
