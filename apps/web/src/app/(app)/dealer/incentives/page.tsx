export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { Spinner } from '../_components/ui';
import { IncentivesWorkspace } from './_components/incentives-workspace';

export const metadata = { title: 'Manufacturer incentives' };

/**
 * /dealer/incentives — manufacturer incentive claims and programs (FPB-dealer-pack
 * §3.9, DL-7). Guarded by the dealer layout; writes are re-authorized by D1 routes.
 */
export default function IncentivesPage() {
  return (
    <Suspense fallback={<Spinner label="Loading incentives…" />}>
      <IncentivesWorkspace />
    </Suspense>
  );
}
