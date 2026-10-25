import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { DesignProject } from '@/components/design/DesignProject';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Design project' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Items by room with components and sidemarks, client approvals item by item, deposits, POs by vendor, fees. */
export default async function DesignProjectPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.selections', 'view', job.location_id);
  const [vres, cres] = await Promise.all([o.db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').eq('is_active', true).order('name').limit(500), job.customer_id ? o.db.schema('core').from('contacts').select('id, first_name, last_name, email').eq('customer_id', job.customer_id).not('email', 'is', null).limit(20) : Promise.resolve({ data: [] })]);
  const vendors = ((vres.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name }));
  const contacts = ((cres.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map((c) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.email ?? 'Contact') }));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Design project', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Design project" actions={<ButtonLink variant="quiet" href="/design">Design procurement</ButtonLink>} />
        {!allowed ? <Denied what="Design project" /> : <><DesignProject jobId={params.jobId} today={todayIso()} vendors={vendors} contacts={contacts} /></>}
      </Page>
    </>
  );
}
