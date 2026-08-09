import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { ReceiptQueue } from './receipt-queue';

export default function ReceiptsPage() {
  // COMPANY-SCOPE CONTROL: receipts are processed per company.
  return (
    <>
      <PageHeader
        title="Receipts"
        description="AI-extracted receipts awaiting review"
      />
      <CompanyScopeGuard>
        <ReceiptQueue />
      </CompanyScopeGuard>
    </>
  );
}
