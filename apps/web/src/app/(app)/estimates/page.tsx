export const dynamic = 'force-dynamic';

import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { EstimatesManager } from './estimates-manager';

export default function EstimatesPage() {
  // COMPANY-SCOPE CONTROL: estimates are quoted from one company's books, so they
  // are pinned to the active company (its location_id) just like invoices.
  return (
    <CompanyScopeGuard>
      <EstimatesManager />
    </CompanyScopeGuard>
  );
}
