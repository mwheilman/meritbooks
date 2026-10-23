export const dynamic = 'force-dynamic';

import { ReconciliationWorkspace } from './reconciliation';

export const metadata = { title: 'Lender statement' };

/** Lender statement / floor-check reconciliation workspace (FPB §3.10, DL-8). */
export default function LenderStatementPage({ params }: { params: { id: string } }) {
  return <ReconciliationWorkspace id={params.id} />;
}
