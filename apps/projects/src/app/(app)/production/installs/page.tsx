import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/dealer/common/depth';
import { InstallsView } from '@/components/manufacturing/InstallsView';
import '@/components/ops/ops.css';
import { jobRefs } from '@/lib/pm/ops/scope';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Installs' };
export const dynamic = 'force-dynamic';

/** Install bookings by crew with shop-completion and site-ready conflicts. */
export default async function InstallsPage() {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/production');
  const companyId = (o.scope.readOnly ? null : o.scope.company?.id ?? (o.companies.length === 1 ? o.companies[0]!.id : null));
  const cres = companyId ? await o.db.schema('pm').from('crews').select('id, name').eq('location_id', companyId).eq('is_active', true).order('name') : null;
  const crews = ((cres?.data ?? []) as Array<{ id: string; name: string }>);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Installs', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Installs" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>} />
        {companyId ? <InstallsView companyId={companyId} today={todayIso()} jobs={jobRefs(o).filter((j) => j.companyId === companyId && j.open)} crews={crews} /> : <OneCompany what="Installs" />}
      </Page>
    </>
  );
}
