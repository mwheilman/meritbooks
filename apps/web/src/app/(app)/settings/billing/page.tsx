export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { BillingPlanView } from './_components/billing-plan-view';

export default async function BillingSettingsPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Plan & cost is an org/system setting — restrict the
  // screen to admin-equivalent roles that may view system settings. Fails closed. Reuses the
  // existing settings_system:view permission (no new permission key invented).
  await requirePagePermission('settings_system', 'view');

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-white mb-1">Plan &amp; billing</h1>
      <p className="text-sm text-slate-400 mb-6">
        Your subscription plan, active company count, and computed monthly cost. No charges are made
        from this page.
      </p>
      <BillingPlanView />
    </div>
  );
}
