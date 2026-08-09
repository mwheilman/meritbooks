import { redirect } from 'next/navigation';

// Retired standalone route. Cash application now lives as the "Apply Deposits" tab of
// the Bank Feed; the AR↔GL tie-out moved onto Reconciliation. Keep the URL working by
// redirecting into its new tab home.
export default function CashApplicationPage() {
  redirect('/bank-feed?tab=apply-deposits');
}
