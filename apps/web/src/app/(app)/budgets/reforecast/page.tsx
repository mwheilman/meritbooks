import { redirect } from 'next/navigation';

// Retired standalone route. The Rolling Reforecast is now a tab of Budgets.
// Keep the URL working by redirecting into its new tab home.
export default function ReforecastPage() {
  redirect('/budgets?tab=reforecast');
}
