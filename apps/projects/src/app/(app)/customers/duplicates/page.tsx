import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { can } from '@/lib/access/can';
import { listOpenReviews } from '@/lib/crm/duplicates';
import { ContractNotLive } from '@/lib/crm/queries';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { DuplicateQueue } from '@/components/customers/DuplicateQueue';
import { CrmNotLive } from '@/components/crm/CrmNotLive';

export const metadata: Metadata = { title: 'Possible duplicates' };
export const dynamic = 'force-dynamic';

/** Customers → Possible duplicates: one queue for Merit Projects and Merit Books (SHARED-RECORDS §4). */
export default async function DuplicatesPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/customers/duplicates');
  const db = await requireDb();
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  let reviews;
  try {
    reviews = await listOpenReviews(db);
  } catch (e) {
    if (!(e instanceof ContractNotLive)) throw e;
    reviews = null;
  }
  return (
    <>
      <PageCrumbs items={[{ label: 'Customers', href: '/customers' }, { label: 'Possible duplicates' }]} />
      <PageLine facts={[where, { label: reviews ? `${count(reviews.length)} pairs to review` : 'Setting up', strong: true }, 'Shared with Merit Books']} />
      <Page>
        <PageHead eyebrow={[where, 'Customers']} title="Possible duplicates">
          <p className="t-cap" style={{ marginTop: 4 }}>Nothing is merged automatically. Merging keeps one record and repoints everything in Projects and Books to it.</p>
        </PageHead>
        <div className="density-cockpit">
          {reviews ? <DuplicateQueue reviews={reviews} canEdit={can(access, 'projects.customers', 'edit')} readOnly={scope.readOnly} /> : <CrmNotLive what="Possible duplicates" />}
        </div>
      </Page>
    </>
  );
}
