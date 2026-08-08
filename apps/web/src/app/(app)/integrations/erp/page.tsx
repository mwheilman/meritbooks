export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ConnectErpStep } from '@/components/integrations/connect-erp-step';

/**
 * Integrations → Connect your existing system.
 *
 * Standalone home for the connector framework. PAGE-LEVEL RBAC (identity gate #9):
 * connecting an operational system is a system/integration setting — gate the screen
 * on settings_system:view. Fails closed. The same <ConnectErpStep> renders inside the
 * onboarding wizard.
 */
export default async function ErpIntegrationsPage() {
  await requirePagePermission('settings_system', 'view');
  return (
    <div className="max-w-5xl mx-auto px-6 py-6 pb-16">
      <ConnectErpStep />
    </div>
  );
}
