import type { Metadata } from 'next';
import { Page, PageHead, WidgetState, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { listActivity } from '@/lib/pm/activity';
import { scopedJobs } from '@/lib/pm/scoped';
import { PageLine } from '@/components/common/PageLine';
import { ActivityFeed } from '@/components/common/ActivityFeed';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Activity' };

export default async function ActivityPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { money: mv } = await guardPage('/activity');
  const db = await requireDb();
  const [rows, jobs] = await Promise.all([listActivity(db, { companyIds: scope.companyIds }, 200), scopedJobs(db, scope)]);
  const labels = Object.fromEntries([...jobs.byId.keys()].map((id) => [id, jobs.label(id) ?? '']));
  const names = Object.fromEntries(scope.tenant.companies.map((c) => [c.id, c.name]));
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageLine facts={[where, { label: `Latest ${count(rows.length)} changes`, strong: true }]} actions={<span className="t-cap">Append-only: nothing here can be edited</span>} />
      <Page>
        <PageHead eyebrow={where} title="Activity" />
        <div className="mp-table">
          {rows.length ? (
            <ActivityFeed rows={rows} jobLabels={labels} companyNames={scope.companyIds.length > 1 ? names : undefined} showMoney={mv.contract} />
          ) : (
            <WidgetState state={{ kind: 'empty', title: 'Nothing has happened yet', body: 'Creating a job, moving a stage, approving a change order and sending progress to Merit Books all land here.' }} />
          )}
        </div>
      </Page>
    </>
  );
}
