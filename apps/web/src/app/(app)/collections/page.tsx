export const dynamic = 'force-dynamic';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { CollectionsTabs } from './collections-tabs';

export default function CollectionsPage() {
  // COMPANY-SCOPE CONTROL: collections work AR for one company at a time.
  return (
    <CompanyScopeGuard>
      <CollectionsTabs />
    </CompanyScopeGuard>
  );
}
