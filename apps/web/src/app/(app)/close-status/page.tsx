import { redirect } from 'next/navigation';

// Retired standalone route. Close readiness is now the "Status" tab of the unified
// Close screen. Keep the URL working by redirecting into its new tab home.
export default function CloseStatusPage() {
  redirect('/close?tab=status');
}
