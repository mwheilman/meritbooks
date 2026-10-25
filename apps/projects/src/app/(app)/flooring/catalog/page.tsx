import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { Denied } from '@/components/dealer/common/Denied';
import { CatalogView } from '@/components/flooring/CatalogView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Flooring catalog' };
export const dynamic = 'force-dynamic';

/** Products, labor codes and crew capacity. */
export default async function FlooringCatalogPage() {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const allowed = can(access, 'projects.estimates', 'view', companyId);
  const cres = companyId ? await o.db.schema('pm').from('crews').select('id, name').eq('location_id', companyId).eq('is_active', true).order('name') : null;
  const crews = ((cres?.data ?? []) as Array<{ id: string; name: string }>);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Flooring catalog', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Flooring catalog" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Flooring catalog" /> : (companyId ? <CatalogView companyId={companyId} crews={crews} /> : <OneCompany what="Flooring catalog" />)}
      </Page>
    </>
  );
}
