import { redirect } from 'next/navigation';

// Retired standalone route. The sales-tax return Worksheet is now the "Worksheet" tab
// of the Tax hub's Sales Tax sub. The view lives in ./sales-tax-return-view and is
// rendered there; keep this URL working by redirecting into its new tab home.
export default function SalesTaxReturnPage() {
  redirect('/tax/sales-tax?tab=worksheet');
}
