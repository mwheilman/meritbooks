import { redirect } from 'next/navigation';

// Retired standalone route. Year-end close is now the "Year-End" tab of the unified
// Close screen. Keep the URL working by redirecting into its new tab home.
export default function YearEndClosePage() {
  redirect('/close?tab=year-end');
}
