export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { Spinner } from '../_components/ui';
import { StatementsList } from './_components/statements-list';

/**
 * Lender statements and floor checks (FPB §3.10, DL-8): every statement / audit /
 * payoff quote for the client, manual entry with a live footing check, and the way
 * into each reconciliation workspace.
 */
export default function LenderStatementsPage() {
  return (
    <div>
      <PageHeader
        title="Lender statements"
        description="Match the lender’s statements and floor checks to Books note by note, resolve the differences, and sign off."
        breadcrumbs={[{ label: 'Dealer', href: '/dealer' }, { label: 'Lender statements' }]}
      />
      <Suspense fallback={<Spinner />}>
        <StatementsList />
      </Suspense>
    </div>
  );
}
