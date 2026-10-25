import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { FlooringReports } from '@/components/flooring/FlooringReports';
import { ownerOptions } from '@/lib/crm/queries';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Flooring reports' };
export const dynamic = 'force-dynamic';

/** Store reports (FLR-44), the salesperson rotation (FLR-03) and vendor price files (FLR-14). */
export default async function FlooringReportsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  const members = companyId && allowed ? await ownerOptions(o.db, [companyId], null) : [];
  return (
    <>
      <PageLine facts={[o.where, { label: 'Flooring reports', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Flooring reports" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Flooring reports" /> : (companyId ? <FlooringReports companyId={companyId} today={todayIso()} members={members} /> : <OneCompany what="Flooring reports" />)}
      </Page>
    </>
  );
}
