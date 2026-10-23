import { redirect } from 'next/navigation';

export const metadata = { title: 'Covenants' };

// Retired standalone route. Covenant monitoring is now a tab of Debt & Loans.
// Keep the URL working by redirecting into its new tab home.
export default function CovenantsPage() {
  redirect('/debt?tab=covenants');
}
