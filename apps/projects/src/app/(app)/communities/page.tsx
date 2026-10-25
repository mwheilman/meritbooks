import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { can } from '@/lib/access/can';
import { loadBuilder } from '@/lib/residential/queries';
import { resPage } from '@/lib/residential/page';
import { PageLine } from '@/components/common/PageLine';
import { CommunitiesSetup } from '@/components/residential/CommunitiesSetup';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Communities' };

export default async function CommunitiesPage() {
  const g = await resPage('/communities', 'projects.jobs', 'view');
  if (!g) return null;
  const { o, access } = g;
  const companyId = o.scope.company?.id ?? null;
  const [b, vendors] = await Promise.all([
    loadBuilder(o.db, o.companyIds),
    companyId ? o.db.schema('pm').from('v_core_vendors_masked').select('id, name, display_name').order('name').limit(1000) : Promise.resolve({ data: [], error: null }),
  ]);
  const vendorList = vendors.error ? [] : ((vendors.data ?? []) as Array<{ id: string; name: string; display_name: string | null }>).map((v) => ({ id: v.id, name: v.display_name || v.name }));
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(b.communities.length)} communities`, strong: true }, `${count(b.lots.length)} lots`, `${count(b.plans.length)} plans`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Communities">
          <p className="t-cap" style={{ marginTop: 4 }}>Land → community → phase → lot; plans, elevations and the option price book with design-center cutoffs; and the trade price agreements a start package releases as purchase orders.</p>
        </PageHead>
        <CommunitiesSetup bundle={b} companyId={companyId} vendors={vendorList}
          canEdit={!!companyId && can(access, 'projects.jobs', 'edit', companyId)} canAgreements={!!companyId && can(access, 'projects.commitments', 'edit', companyId)} />
      </Page>
    </>
  );
}
