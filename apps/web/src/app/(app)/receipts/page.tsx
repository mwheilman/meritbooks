import { PageHeader } from '@/components/ui';
import { ReceiptQueue } from './receipt-queue';

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        description="AI-extracted receipt data with side-by-side verification"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">Upload Receipt</button>
            <button className="btn-primary btn-sm">Batch Approve</button>
          </div>
        }
      />
      <ReceiptQueue />
    </>
  );
}
