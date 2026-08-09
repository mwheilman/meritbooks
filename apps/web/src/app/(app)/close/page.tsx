import { Suspense } from 'react';
import { CloseTabs } from './close-tabs';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

export default async function ClosePage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view close
  // management reach this screen; everyone else is redirected. Fails closed.
  await requirePagePermission('close_mgmt', 'view');
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <CompanyScopeGuard>
      <Suspense fallback={null}>
        <CloseTabs />
      </Suspense>
    </CompanyScopeGuard>
  );
}
