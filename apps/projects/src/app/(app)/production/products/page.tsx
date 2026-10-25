import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { estimateOpts } from '@/lib/mfg/page-data';
import { ProductLibraryView } from '@/components/manufacturing/completion/FrontOffice';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Product library' };
export const dynamic = 'force-dynamic';

export default async function ProductionProductsPage() {
  return (
    <MfgShell guard="/production/products" title="Product library" actions={<><ButtonLink variant="quiet" href="/production/takeoff">Takeoff</ButtonLink><ButtonLink variant="quiet" href="/estimates">Estimates</ButtonLink></>}>
      {async ({ companyId, o, today }) => {
      const estimates = await estimateOpts(o.db, companyId, (id) => o.jobs.label(id) ?? '', ['DRAFT']);
      return <ProductLibraryView companyId={companyId} estimates={estimates} />;
      }}
    </MfgShell>
  );
}
