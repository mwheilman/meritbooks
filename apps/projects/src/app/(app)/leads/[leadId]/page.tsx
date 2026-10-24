import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { can } from '@/lib/access/can';
import { listJobTypes } from '@/lib/pm/projects';
import { loadLeadDetail } from '@/lib/crm/detail';
import { ContractNotLive, getLead, ownerOptions } from '@/lib/crm/queries';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { LeadPage } from '@/components/crm/LeadPage';
import { CrmNotLive } from '@/components/crm/CrmNotLive';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: { leadId: string } }): Promise<Metadata> {
  if (!UUID.test(params.leadId)) return { title: 'Lead' };
  const lead = await getLead(await requireDb(), params.leadId).catch(() => null);
  return { title: lead?.title ?? 'Lead' };
}

/** One lead (BP-39/47/48/52): stage, person, site, timeline, follow-ups, convert. */
export default async function LeadDetailPage({ params }: { params: { leadId: string } }) {
  if (!UUID.test(params.leadId)) notFound();
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/leads');
  const db = await requireDb();
  const today = todayIso();
  let detail;
  try {
    detail = await loadLeadDetail(db, access, scope.tenant.companies, params.leadId, { nowMs: Date.now(), today });
  } catch (e) {
    if (e instanceof ContractNotLive) {
      return <Page><PageHead title="Lead" /><CrmNotLive what="Leads" /></Page>;
    }
    throw e;
  }
  if (!detail) notFound();
  const co = detail.lead.companyId;
  if (!scope.tenant.companies.some((c) => c.id === co)) notFound();
  const [owners, jobTypes] = await Promise.all([ownerOptions(db, [co], access.membershipId), listJobTypes(db, [co])]);
  const company = scope.tenant.companies.find((c) => c.id === co)?.name ?? '';
  const l = detail.lead;
  const open = detail.followups.filter((f) => !f.doneAt).length;

  return (
    <>
      <PageCrumbs items={[{ label: 'Leads', href: '/leads' }, { label: l.title }]} />
      <PageLine facts={[
        company,
        { label: l.stageName, strong: true },
        l.speed?.state === 'waiting' ? 'No touch yet' : `${count(l.daysInStage)} days in stage`,
        ...(open ? [`${count(open)} follow-ups open`] : []),
      ]} />
      <Page>
        <PageHead eyebrow={[company, detail.pipeline.name]} title={l.title}>
          <p className="t-cap" style={{ marginTop: 4 }}>{[l.customerName ?? l.contactName, l.site].filter(Boolean).join(' · ') || 'No customer linked yet'}</p>
        </PageHead>
        <div className="density-cockpit">
          <LeadPage
            detail={detail}
            today={today}
            canEdit={can(access, 'projects.leads', 'edit', co)}
            canEstimate={can(access, 'projects.estimates', 'create', co)}
            canJob={can(access, 'projects.jobs', 'create', co)}
            showMoney={can(access, 'projects.contract_value', 'view', co)}
            owners={owners}
            jobTypes={jobTypes.map((j) => ({ key: j.key, label: j.label }))}
            readOnly={scope.readOnly}
          />
        </div>
      </Page>
    </>
  );
}
