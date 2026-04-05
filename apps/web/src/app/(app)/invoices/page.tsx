import { PageHeader } from '@/components/ui';
import { InvoiceList } from './invoice-list';

export default function InvoicesPage() {
  return (
    <>
      <PageHeader
        title="Invoices & AR"
        description="Customer invoicing, aging, and payment tracking"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">AR Aging</button>
            <button className="btn-primary btn-sm">New Invoice</button>
          </div>
        }
      />
      <InvoiceList />
    </>
  );
}
