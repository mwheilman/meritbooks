import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, has, jobRefs, vendorNames } from '@/lib/pm/ops/scope';
import { loadPunch } from '@/lib/pm/ops/records-queries';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ModuleOff } from '@/components/ops/common/ModuleOff';
import { PunchView } from '@/components/ops/records/PunchView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Punch list' };
export const dynamic = 'force-dynamic';

export default async function PunchListPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/punch-list');
  const items = await loadPunch(o.db, { companyIds: o.companyIds }, (id) => o.jobs.byId.has(id));
  if (!has(o, 'punch_warranty') && items.length === 0) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Punch list" />
          <ModuleOff title="Punch lists and warranty" what="Punch, warranty and callback items by area, with who owns each one." />
        </Page>
      </>
    );
  }
  const today = todayIso();
  const open = items.filter((i) => ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW'].includes(i.status));
  const late = open.filter((i) => i.due_on && i.due_on < today).length;
  const vendors = await vendorNames(o.db, items.map((i) => i.responsible_vendor_id));
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(open.length)} open`, strong: true }, ...(late ? [`${count(late)} past due`] : []), `${count(new Set(open.map((i) => i.job_id)).size)} jobs`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Punch list" />
        <PunchView items={items} jobs={jobRefs(o)} vendors={vendors} today={today} />
      </Page>
    </>
  );
}
