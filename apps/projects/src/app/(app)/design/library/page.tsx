import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { DesignLibrary } from '@/components/design/DesignLibrary';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Product library' };
export const dynamic = 'force-dynamic';

/** The firm’s product library (ID-07/08), pricing rules (ID-14) and design reports (ID-36). */
export default async function ProductLibraryPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.selections', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Product library', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Product library" actions={<ButtonLink variant="quiet" href="/design">Design</ButtonLink>} />
        {!allowed ? <Denied what="Product library" /> : (companyId ? <DesignLibrary companyId={companyId} today={todayIso()} /> : <OneCompany what="Product library" />)}
      </Page>
    </>
  );
}
