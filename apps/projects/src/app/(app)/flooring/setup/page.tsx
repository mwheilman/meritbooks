import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { FlooringSetup } from '@/components/flooring/FlooringSetup';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Flooring setup' };
export const dynamic = 'force-dynamic';

/** Flooring store setup (FLR-01). */
export default async function FlooringSetupPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.settings', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Flooring setup', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Flooring setup" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Flooring setup" /> : (companyId ? <FlooringSetup companyId={companyId} /> : <OneCompany what="Flooring setup" />)}
      </Page>
    </>
  );
}
