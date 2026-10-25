import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { CapacityBoard } from '@/components/residential/CapacityBoard';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Crew and trade capacity' };
export const dynamic = 'force-dynamic';

/** Multi-job crew and trade capacity (RES-49): load by week against what each crew and trade can carry. */
export default async function CrewAndTradeCapacityPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.jobs', 'view', companyId);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Crew and trade capacity', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Crew and trade capacity" actions={<ButtonLink variant="quiet" href="/homes">Homes</ButtonLink>} />
        {!allowed ? <Denied what="Crew and trade capacity" /> : (companyId ? <CapacityBoard companyId={companyId} /> : <OneCompany what="Crew and trade capacity" />)}
      </Page>
    </>
  );
}
