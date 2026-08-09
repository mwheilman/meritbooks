import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { ChecksClient } from './checks-client';

export const dynamic = 'force-dynamic';

export default async function ChecksPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Check management is a sensitive,
  // separation-of-duties money surface — only roles that may view Checks reach
  // this screen; everyone else is redirected. Fails closed. The approve route
  // still enforces canApprove + preparer!=approver independently.
  await requirePagePermission('checks', 'view');
  // COMPANY-SCOPE CONTROL: check runs disburse from one company's bank account.
  return (
    <CompanyScopeGuard>
      <ChecksClient />
    </CompanyScopeGuard>
  );
}
