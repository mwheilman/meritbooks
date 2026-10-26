import { Page, PageHead } from '@meritbooks/merit-ui';
import { DuplicateQueue } from '@/components/parties/duplicate-queue';

export const dynamic = 'force-dynamic';

/**
 * /customers/duplicates — the ONE duplicate review queue Books and Projects share (core.duplicate_reviews,
 * Projects migration 1111). Guarded by the customers layout (customers:view); merging needs customers:edit.
 */
export default function CustomerDuplicatesPage() {
  return (
    <Page>
      <PageHead eyebrow={['Receivables', 'Customers', 'Possible duplicates']} title="Possible duplicate customers">
        Customers entered in Books or Merit Projects that look like the same client. Keep one — everything moves to it — or mark the pair as different.
      </PageHead>
      <DuplicateQueue kind="customer" />
    </Page>
  );
}
