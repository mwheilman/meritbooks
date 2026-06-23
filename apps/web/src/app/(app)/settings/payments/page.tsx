export const dynamic = 'force-dynamic';

import { PaymentsConnect } from '../payments-connect';

export default function PaymentsSettingsPage() {
  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-white mb-1">Payments</h1>
      <p className="text-sm text-slate-400 mb-6">Connect Stripe so customers can pay invoices online by card or bank transfer.</p>
      <PaymentsConnect />
    </div>
  );
}
