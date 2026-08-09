import { redirect } from 'next/navigation';

// Retired standalone route. Credit-card matching is now the "Credit Cards" tab of the
// Bank Feed. Keep the URL working by redirecting into its new tab home.
export default function CreditCardsPage() {
  redirect('/bank-feed?tab=credit-cards');
}
