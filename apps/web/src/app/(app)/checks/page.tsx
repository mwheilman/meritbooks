import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { CheckProcessor } from './check-processor';

export const dynamic = 'force-dynamic';

/**
 * /checks — the check processor (Wave 2C, docs/FPB-check-processing.md): print released
 * check payments on blank stock, the check register, voids, positive pay, check stock, and
 * the pay run (queue → approve → release).
 *
 * PAGE-LEVEL RBAC (identity gate #9): only roles that may view Checks reach this screen.
 * Every action route re-checks release authority, the session policy and SoD itself.
 */
export default async function ChecksPage() {
  await requirePagePermission('checks', 'view');
  // COMPANY-SCOPE CONTROL: checks are drawn on one company's bank account.
  return (
    <CompanyScopeGuard>
      <CheckProcessor />
    </CompanyScopeGuard>
  );
}
