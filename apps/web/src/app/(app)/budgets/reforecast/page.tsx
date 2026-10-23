import { redirect } from 'next/navigation';

export const metadata = { title: 'Reforecast' };

// Retired standalone route. The Rolling Reforecast is now a tab of Budgets.
// Keep the URL working by redirecting into its new tab home.
export default function ReforecastPage() {
  redirect('/budgets?tab=reforecast');
}
