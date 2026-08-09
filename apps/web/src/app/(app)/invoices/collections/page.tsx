import { redirect } from 'next/navigation';

// RETIRED — the older AR-aging collections worklist was merged into the unified
// Collections page. It now lives on the "Aging Buckets" tab at /collections. Kept
// as a redirect so existing deep links keep working. (The CollectionsDashboard
// component in this folder is still rendered — embedded — by /collections.)
export default function InvoicesCollectionsRedirect() {
  redirect('/collections?tab=aging');
}
