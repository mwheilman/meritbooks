import { redirect } from 'next/navigation';

// Retired standalone route. Intercompany due-to/due-from is now a tab of Consolidation
// (which already consumes intercompany data for eliminations). The workspace lives in
// ./intercompany-workspace and is rendered by the Consolidation shell; keep this URL
// working by redirecting into its new tab home.
export default function IntercompanyPage() {
  redirect('/consolidation?tab=intercompany');
}
