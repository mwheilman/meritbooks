import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { OwnerDashboard } from '@/components/residential/OwnerDashboard';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Owner dashboard' };
export const dynamic = 'force-dynamic';

/** Owner dashboard (RES-123): pipeline, backlog, cash, margin fade and jobs at risk across the company (or every company in view). */
export default async function OwnerDashboardPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const companyId = o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null);
  const allowed = companyId ? can(access, 'projects.jobs', 'view', companyId) : o.companyIds.some((id) => can(access, 'projects.jobs', 'view', id));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Owner dashboard', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Owner dashboard" actions={<ButtonLink variant="quiet" href="/homes">Homes</ButtonLink>} />
        {!allowed ? <Denied what="Owner dashboard" /> : <OwnerDashboard companyId={companyId} />}
      </Page>
    </>
  );
}
