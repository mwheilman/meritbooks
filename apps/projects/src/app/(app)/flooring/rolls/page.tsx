import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { RollsView } from '@/components/flooring/RollsView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Rolls and remnants' };
export const dynamic = 'force-dynamic';

/** Roll goods by product and dye lot, receiving, remnants. */
export default async function RollsAndRemnantsPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Rolls and remnants', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Rolls and remnants" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Rolls and remnants" /> : (companyId ? <RollsView companyId={companyId} today={todayIso()} /> : <OneCompany what="Rolls and remnants" />)}
      </Page>
    </>
  );
}
