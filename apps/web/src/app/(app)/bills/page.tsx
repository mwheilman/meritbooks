import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { BillsClient } from './bills-client';

export const dynamic = 'force-dynamic';

export default async function BillsPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view Bills/AP reach
  // this screen; everyone else is redirected. Fails closed. Route handlers still
  // enforce create/approve independently.
  await requirePagePermission('bills', 'view');
  // COMPANY-SCOPE CONTROL: processing must target one company. When "All" is
  // active the guard shows a company picker instead of consolidated AP.
  return (
    <CompanyScopeGuard>
      <BillsClient />
    </CompanyScopeGuard>
  );
}
