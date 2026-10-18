export const dynamic = 'force-dynamic';

import { PaymentsConnect } from '../payments-connect';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export default async function PaymentsSettingsPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Connecting a payment processor is a
  // system/integration setting — restrict the screen to roles that may view it.
  // Fails closed.
  await requirePagePermission('settings_system', 'view');
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-white mb-1">Payments</h1>
      <p className="text-sm text-slate-400 mb-6">Connect Stripe so customers can pay invoices online by card or bank transfer.</p>
      <PaymentsConnect />
    </div>
  );
}
