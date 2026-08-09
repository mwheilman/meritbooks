import { redirect } from 'next/navigation';

// Retired standalone route. The sales-tax Filing Calendar is now the "Filing Calendar"
// tab of the Tax hub's Sales Tax sub. The view lives in ./sales-tax-calendar-view and
// is rendered there; keep this URL working by redirecting into its new tab home.
export default function SalesTaxCalendarPage() {
  redirect('/tax/sales-tax?tab=calendar');
}
