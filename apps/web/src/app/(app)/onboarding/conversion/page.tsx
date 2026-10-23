export const dynamic = 'force-dynamic';

import ConversionClient from './conversion-client';

export const metadata = { title: 'Historical conversion' };

/**
 * /onboarding/conversion — bring a company's opening balances over from the old system.
 * Optional prefill via query string (deep links): ?companyId=<location uuid>&asOf=YYYY-MM-DD,
 * and ?intake=<storagePath> — a TB/GL file already dropped in Smart Intake (read from
 * storage; the TB route re-validates the path is inside the caller's org).
 * The onboarding wizard can instead render <ConversionClient defaultCompanyId defaultAsOfDate />.
 */
export default function ConversionPage({ searchParams }: { searchParams?: { companyId?: string; asOf?: string; intake?: string } }) {
  const companyId = typeof searchParams?.companyId === 'string' && searchParams.companyId ? searchParams.companyId : null;
  const asOf = typeof searchParams?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.asOf) ? searchParams.asOf : null;
  const intake = typeof searchParams?.intake === 'string' && searchParams.intake.startsWith('intake/') && !searchParams.intake.includes('..')
    ? searchParams.intake
    : null;
  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white tracking-tight">Bring your opening balances over</h1>
        <p className="text-sm text-slate-400 mt-1 max-w-3xl">
          Drop the list of account balances from your old system (your trial balance). We match each of your accounts
          to a MeritBooks account, you check the numbers match, and we post them as one balanced opening entry.
          Nothing posts until you confirm.
        </p>
      </div>
      <ConversionClient defaultCompanyId={companyId} defaultAsOfDate={asOf} initialStoragePath={intake} />
    </div>
  );
}
