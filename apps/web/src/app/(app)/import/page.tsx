export const dynamic = 'force-dynamic';

import ImportClient from './import-client';

export default function ImportPage() {
  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white tracking-tight">Import Data</h1>
        <p className="text-sm text-slate-400 mt-1">
          Bring existing master data and balances into MeritBooks. Master data lands in the shared Suite Core layer; ledger data lands in the Books general ledger.
        </p>
      </div>
      <ImportClient />
    </div>
  );
}
