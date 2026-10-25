import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { InvoiceInbox } from '@/components/development/InvoiceInbox';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Invoice inbox' };
export const dynamic = 'force-dynamic';

/** The sponsor’s central invoice inbox (RED-21). */
export default async function InvoiceInboxPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.billing', 'view', companyId);
  const jobIds = [...o.jobs.byId.values()].filter((j) => j.location_id === companyId).map((j) => j.job_id);
  const dres = companyId && allowed && jobIds.length ? await o.db.schema('pm').from('draws').select('id, job_id, draw_number, status').in('job_id', jobIds.slice(0, 500)).in('status', ['DRAFT', 'RETURNED']).order('draw_number', { ascending: false }) : { data: [] };
  const draws = ((dres.data ?? []) as Array<{ id: string; job_id: string; draw_number: number; status: string }>).map((d) => ({ id: d.id, jobId: d.job_id, label: `${o.jobs.label(d.job_id) ?? 'Project'} · draw #${d.draw_number}${d.status === 'RETURNED' ? ' (returned)' : ''}` }));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Invoice inbox', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Invoice inbox" actions={<ButtonLink variant="quiet" href="/development">Development</ButtonLink>} />
        {!allowed ? <Denied what="Invoice inbox" /> : (companyId ? <InvoiceInbox companyId={companyId} today={todayIso()} draws={draws} /> : <OneCompany what="Invoice inbox" />)}
      </Page>
    </>
  );
}
