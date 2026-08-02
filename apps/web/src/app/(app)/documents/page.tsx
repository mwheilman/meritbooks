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
        description="Every retained source document in one place — contracts, bills, statements, policies, W-9s, and COIs. Upload files, browse and filter by type, and trace each document back to the record it supports. Source files from drop-and-parse features are stored and linked here."
      />
      <DocumentsCenter />
    </>
  );
}
