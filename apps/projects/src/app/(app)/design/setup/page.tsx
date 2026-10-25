import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { DesignSetup } from '@/components/design/DesignSetup';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Design firm setup' };
export const dynamic = 'force-dynamic';

/** Interior design firm setup (ID-01). */
export default async function DesignFirmSetupPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.settings', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Design firm setup', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Design firm setup" actions={<ButtonLink variant="quiet" href="/design">Design</ButtonLink>} />
        {!allowed ? <Denied what="Design firm setup" /> : (companyId ? <DesignSetup companyId={companyId} /> : <OneCompany what="Design firm setup" />)}
      </Page>
    </>
  );
}
