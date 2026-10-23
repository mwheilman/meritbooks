export const dynamic = 'force-dynamic';

import { DealerHome } from './home/dealer-home';

export const metadata = { title: 'Dealer home' };

/**
 * Dealer home (FPB-dealer-pack §7 widgets, D2 slice A). Page guard + one-client
 * scope live in ../dealer/layout.tsx. Sold-out-of-trust first, then floor-plan
 * position, inventory aging, manufacturer receivables, reconciliation and tie-out.
 */
export default function DealerHomePage() {
  return <DealerHome />;
}
