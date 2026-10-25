import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { SetupInterview } from '@/components/residential/SetupInterview';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Residential setup' };
export const dynamic = 'force-dynamic';

/** The residential setup interview (RES-01). */
export default async function ResidentialSetupPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.settings', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Residential setup', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Residential setup" actions={<ButtonLink variant="quiet" href="/homes">Homes</ButtonLink>} />
        {!allowed ? <Denied what="Residential setup" /> : (companyId ? <SetupInterview companyId={companyId} /> : <OneCompany what="Residential setup" />)}
      </Page>
    </>
  );
}
