export const dynamic = 'force-dynamic';

import ReconciliationClient from './reconciliation-client';

export default function ReconciliationPage() {
  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white tracking-tight">Conversion Reconciliation</h1>
        <p className="text-sm text-slate-400 mt-1">
          MeritBooks vs. your source books, side by side. Opening balance sheet, A/R aging, A/P aging and
          the WIP schedule — each with a variance that must be zero to go live. This is the report to hold
          next to QuickBooks during your parallel month.
        </p>
      </div>
      <ReconciliationClient />
    </div>
  );
}
