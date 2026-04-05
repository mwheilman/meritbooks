import { PageHeader } from '@/components/ui';
import { ReceiptQueue } from './receipt-queue';

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        description="AI-extracted receipts awaiting review"
      />
      <ReceiptQueue />
    </>
  );
}
