import { redirect } from 'next/navigation';

// Retired standalone route. The Driver-Based Budget Builder is now a tab of Budgets.
// Keep the URL working by redirecting into its new tab home.
export default function DriverBudgetPage() {
  redirect('/budgets?tab=drivers');
}
