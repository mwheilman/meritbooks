import { redirect } from 'next/navigation';

// Retired standalone route. The SOX controls command center is now the "Controls" tab
// of the merged Compliance & Controls screen (both share the `compliance` permission,
// which is enforced by the /compliance page guard). Keep the URL working by redirecting
// into its new tab home.
export default function ControlsPage() {
  redirect('/compliance?tab=controls');
}
