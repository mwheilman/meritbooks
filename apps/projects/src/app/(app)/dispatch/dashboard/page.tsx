import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { RoleDashboard } from '@/components/fieldservice/dashboard/RoleDashboard';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadFindings, rpcLoad } from '@/lib/fieldservice/completion';
import type { Dashboard, DashboardRole } from '@/lib/fieldservice/completion-types';
import { METRICS } from '@/lib/fieldservice/qa';

export const metadata: Metadata = { title: 'Field service dashboard' };
export const dynamic = 'force-dynamic';

const ROLES: readonly DashboardRole[] = ['gm', 'dispatcher', 'service_manager', 'install_pm'];

/** Role dashboards (FS-109), plain-language questions (FS-110) and billing integrity findings (FS-112). */
export default async function FieldDashboardPage({ searchParams }: { searchParams: { role?: string } }) {
  const g = await fsPage([['projects.dispatch', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Field service dashboard" /><OneCompany what="The field-service dashboard" /></Page></>);
  const finance = g.can('projects.financials', 'view') || g.can('projects.reports', 'view');
  const roles = ROLES.filter((r) => r !== 'gm' || finance);
  const asked = ROLES.find((r) => r === searchParams.role);
  const role: DashboardRole = asked && roles.includes(asked) ? asked : roles.includes('dispatcher') ? 'dispatcher' : roles[0]!;
  const canAudit = g.can('projects.billing', 'view') || g.can('projects.reports', 'view') || g.can('projects.financials', 'view');
  const [dash, findings] = await Promise.all([
    rpcLoad<Dashboard | null>(o.db, 'fs_dashboard', { p_location: companyId, p_role: role, p_from: null, p_to: null }, null),
    canAudit ? loadFindings(o.db, companyId) : Promise.resolve({ data: [], error: null }),
  ]);
  const company = o.companyName(companyId) ?? o.where;
  return (
    <>
      <PageLine facts={[company, ...(dash.data ? [`${dash.data.from} to ${dash.data.to}`] : [])]} />
      <Page>
        <PageHead eyebrow={company} title="Field service dashboard" />
        <RoleDashboard companyId={companyId} role={role} roles={[...roles]} dashboard={dash.data} error={dash.error ?? findings.error}
          findings={findings.data} metrics={METRICS.map((m) => ({ key: m.key, label: m.label, example: m.example }))}
          canAudit={canAudit} canDismiss={g.can('projects.billing', 'approve') || g.can('projects.financials', 'edit')} />
      </Page>
    </>
  );
}
