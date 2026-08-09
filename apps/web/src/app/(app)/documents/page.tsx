import { PageHeader } from '@/components/ui';
import { DocumentsCenter } from './documents-center';

export const metadata = {
  title: 'Documents',
};

export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        title="Document Management Center"
        description="Every retained source document in one place — contracts, bills, statements, policies, W-9s, and COIs. Search by file name, filter by type, linked record, or date, and jump straight to the bill, lease, or covenant a document supports. Track inbound files in the Unfiled view until they're linked. Source files from drop-and-parse features are stored and linked here automatically."
      />
      <DocumentsCenter />
    </>
  );
}
