export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { Spinner } from '../_components/ui';
import { FloorPlanWorkspace } from './_components/workspace';

export const metadata = { title: 'Floor plan' };

/**
 * Floor plan (FPB-dealer-pack §3.1–3.4, DL-1/2/9/10): line positions, sold-out-of-trust,
 * notes, curtailments, the payoff queue (propose ≠ release), month-end interest and
 * lender setup. Auth + client guard come from the dealer layout; every write is
 * re-authorized by the D1 routes.
 */
export default function FloorPlanPage() {
  return (
    <div>
      <PageHeader
        title="Floor plan"
        description="What the dealer owes its floor-plan lenders, unit by unit — and what has to be paid before the lender finds it."
        breadcrumbs={[{ label: 'Dealer', href: '/dealer' }, { label: 'Floor plan' }]}
      />
      <Suspense fallback={<Spinner />}>
        <FloorPlanWorkspace />
      </Suspense>
    </div>
  );
}
