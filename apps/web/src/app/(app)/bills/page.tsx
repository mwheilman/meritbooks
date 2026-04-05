import { PageHeader } from '@/components/ui';
import { BillList } from './bill-list';

export default function BillsPage() {
  return (
    <>
      <PageHeader
        title="Bills & AP"
        description="Vendor invoices with AI categorization and compliance checks"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">AP Aging</button>
            <button className="btn-primary btn-sm">New Bill</button>
          </div>
        }
      />
      <BillList />
    </>
  );
}
