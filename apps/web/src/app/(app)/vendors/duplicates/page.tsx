import { Page, PageHead } from '@meritbooks/merit-ui';
import { DuplicateQueue } from '@/components/parties/duplicate-queue';

export const dynamic = 'force-dynamic';

/**
 * /vendors/duplicates — vendor pairs in the shared duplicate review queue (core.duplicate_reviews, Projects
 * migration 1111). Guarded by the vendors layout (vendors:view); merging needs vendors:edit.
 */
export default function VendorDuplicatesPage() {
  return (
    <Page>
      <PageHead eyebrow={['Payables', 'Vendors', 'Possible duplicates']} title="Possible duplicate vendors">
        Vendors entered in Books or Merit Projects that look like the same company. Keep one — bills, commitments and history move to it — or mark the pair as different.
      </PageHead>
      <DuplicateQueue kind="vendor" />
    </Page>
  );
}
