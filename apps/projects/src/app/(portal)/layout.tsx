import type { Metadata } from 'next';
import '@/components/portal/portal.css';

export const metadata: Metadata = {
  title: 'Project portal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Customer, sub / vendor and lender portals (1118): no Clerk, no app shell — their own light frame. */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
