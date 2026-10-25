import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { BacklogView } from '@/components/manufacturing/BacklogView';
import '@/components/ops/ops.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Shop backlog' };
export const dynamic = 'force-dynamic';

/** Backlog in shop hours against each work center's capacity, week by week. */
export default async function ShopBacklogPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  return (
    <>
      <PageLine facts={[o.where, { label: 'Shop backlog', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Shop backlog" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        {companyId ? <BacklogView companyId={companyId} today={todayIso()} /> : <OneCompany what="Shop backlog" />}
      </Page>
    </>
  );
}
