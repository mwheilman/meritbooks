import { PageHeader } from '@/components/ui';
import { VendorList } from './vendor-list';

export default function VendorsPage() {
  return (
    <>
      <PageHeader
        title="Vendors"
        description="AI-learned defaults, compliance tracking, and 1099 management"
        actions={
          <button className="btn-primary btn-sm">Add Vendor</button>
        }
      />
      <VendorList />
    </>
  );
}
