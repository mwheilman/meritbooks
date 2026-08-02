import { PageHeader } from '@/components/ui';
import { TaxPackageClient } from './tax-package-client';

export default function TaxPackagePage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Tax Return Package"
        description="A 1120-style corporate tax hand-off an accountant can take straight to the return — book income to taxable income (Schedule M-1), tax-vs-book depreciation, the ASC 740 current + deferred provision with effective-rate reconciliation, and the DTA/DTL rollforward. Aggregated from the ledger; nothing is recomputed and nothing posts."
      />
      <TaxPackageClient />
    </div>
  );
}
