import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { InstallersView } from '@/components/flooring/InstallersView';
import { installerPicks } from '@/lib/flooring/people';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Installers' };
export const dynamic = 'force-dynamic';

/** Installer roster and compliance (FLR-32) and install confirmations (FLR-31). */
export default async function InstallersPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  const picks = companyId && allowed ? await installerPicks(o.db, companyId) : { vendors: [], employees: [], crews: [] };
  return (
    <>
      <PageLine facts={[o.where, { label: 'Installers', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Installers" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Installers" /> : (companyId ? <InstallersView companyId={companyId} today={todayIso()} {...picks} /> : <OneCompany what="Installers" />)}
      </Page>
    </>
  );
}
