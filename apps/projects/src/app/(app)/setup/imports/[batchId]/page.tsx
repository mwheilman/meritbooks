import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { BatchDetail } from '@/components/imports/BatchDetail';

export const metadata: Metadata = { title: 'Import' };
export const dynamic = 'force-dynamic';

/** /setup/imports/:batchId — what each row of one import became. Access is checked by the API (settings:configure at its company). */
export default async function ImportBatchPage({ params }: { params: { batchId: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  return (
    <Page>
      <PageHead eyebrow={['Settings', 'Imports']} title="Import">
        <ButtonLink variant="quiet" href="/setup/imports" icon="left">All imports</ButtonLink>
      </PageHead>
      <BatchDetail batchId={params.batchId} />
    </Page>
  );
}
