import { PageHeader } from '@/components/ui';
import { BillList } from './bill-list';

export default function BillsPage() {
  return (
    <>
      <PageHeader
        title="Bills"
        description="Vendor invoices with compliance tracking"
      />
      <BillList />
    </>
  );
}
