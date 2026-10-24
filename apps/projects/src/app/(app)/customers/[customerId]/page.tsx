import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Page, PageHead, Tag, count, shortDate } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { booksUrl } from '@/lib/books-url';
import { requireDb } from '@/lib/pm/db';
import { can } from '@/lib/access/can';
import { loadCustomer360 } from '@/lib/crm/customers';
import { RELATIONSHIP_WORDS } from '@/lib/crm/types';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { Customer360View } from '@/components/customers/Customer360View';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: { customerId: string } }): Promise<Metadata> {
  if (!UUID.test(params.customerId)) return { title: 'Customer' };
  const db = await requireDb();
  const r = await db.schema('pm').from('v_core_customers_masked').select('name, display_name').eq('id', params.customerId).maybeSingle();
  const c = r.data as { name: string; display_name: string | null } | null;
  return { title: c ? c.display_name || c.name : 'Customer' };
}

/** The customer 360 (panel 06 BP-62..69): one page per customer, sections by role. */
export default async function CustomerPage({ params }: { params: { customerId: string } }) {
  if (!UUID.test(params.customerId)) notFound();
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/customers');
  const db = await requireDb();
  const data = await loadCustomer360(db, access, params.customerId, { companyId: scope.company?.id ?? null, companyIds: scope.companyIds });
  if (!data) notFound();
  if ('mergedInto' in data) redirect(`/customers/${data.mergedInto}`);
  const c = data.customer;
  const at = c.companyId ?? scope.company?.id ?? null;
  const company = c.companyId ? scope.tenant.companies.find((x) => x.id === c.companyId)?.name ?? null : null;
  const rel = data.relationship;
  const openJobs = data.jobs.ok ? data.jobs.value.filter((j) => j.status === 'ACTIVE' || j.status === 'BID' || j.status === 'ON_HOLD').length : 0;
  const openLeads = data.leads.ok ? data.leads.value.filter((l) => l.kind === 'open').length : 0;

  return (
    <>
      <PageCrumbs items={[{ label: 'Customers', href: '/customers' }, { label: c.name }]} />
      <PageLine facts={[
        company ?? 'Shared customer',
        { label: rel ? `${RELATIONSHIP_WORDS[rel.stage]}${rel.since ? ` since ${shortDate(rel.since)}` : ''}` : 'Customer', strong: true },
        `${count(openJobs)} open jobs`,
        ...(openLeads ? [`${count(openLeads)} open leads`] : []),
      ]} />
      <Page>
        <PageHead eyebrow={[company ?? 'Shared with all companies', 'Customer']} title={c.name} actions={rel ? <Tag tone={rel.stage === 'customer' ? 'pos' : rel.stage === 'former' ? 'warn' : 'default'}>{RELATIONSHIP_WORDS[rel.stage]}</Tag> : undefined}>
          <p className="t-cap" style={{ marginTop: 4 }}>{[c.email, c.phone, c.address].filter(Boolean).join(' · ') || 'No contact details yet'} · added {shortDate(c.createdAt)}</p>
        </PageHead>
        <div className="density-cockpit">
          <Customer360View
            data={data}
            today={todayIso()}
            canEdit={can(access, 'projects.customers', 'edit', at)}
            canCreate={can(access, 'projects.customers', 'create', at)}
            canLeads={can(access, 'projects.leads', 'view', at)}
            booksUrl={scope.tenant.booksPresent ? `${booksUrl()}/customers/${c.id}` : null}
            readOnly={scope.readOnly}
          />
        </div>
      </Page>
    </>
  );
}
