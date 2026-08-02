export const dynamic = 'force-dynamic';

import ConversionClient from './conversion-client';

export default function ConversionPage() {
  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white tracking-tight">Historical Conversion</h1>
        <p className="text-sm text-slate-400 mt-1">
          Bring a company&apos;s prior books into MeritBooks. Upload a trial balance, let AI propose the
          account mapping, review the proposed opening balances, and go live only once a person has tied out.
          MeritBooks owns the general ledger from that point on.
        </p>
      </div>
      <ConversionClient />
    </div>
  );
}
