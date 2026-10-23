import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { RequestsScreen } from './requests-screen';

export const metadata = { title: 'Requests' };

/**
 * REQUESTS — everything the books are waiting on from someone else (vendor W-9 / COI,
 * client questions, documents, approvals; receipts and payment reminders as their flows
 * land), how hard each has been asked, and what happens next. FPB-request-engine-
 * notifications §5. Page-level RBAC: compliance:view (fails closed before any client JS).
 */
export default async function RequestsPage() {
  await requirePagePermission('compliance', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading requests…</p>}>
      <RequestsScreen />
    </Suspense>
  );
}
