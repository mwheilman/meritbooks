import { redirect } from 'next/navigation';

// Retired standalone route. The 13-week cash forecast is now a tab of Cash Position.
// Keep the URL working by redirecting into its new tab home.
export default function ForecastPage() {
  redirect('/cash?tab=forecast');
}
