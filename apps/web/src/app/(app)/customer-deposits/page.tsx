export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { DepositsManager } from './deposits-manager';

/**
 * Customer Deposits / Retainers — unapplied customer cash held as a liability
 * (Customer Deposits, 2420) and drawn down against invoices.
 *
 * Page-level RBAC: reuses `invoices:view` (deposits are an AR-adjacent surface).
 * Processing is company-scoped like all AR work, so it sits behind the
 * CompanyScopeGuard.
 */
export default async function CustomerDepositsPage() {
  await requirePagePermission('invoices', 'view');
  return (
    <CompanyScopeGuard>
      <DepositsManager />
    </CompanyScopeGuard>
  );
}
