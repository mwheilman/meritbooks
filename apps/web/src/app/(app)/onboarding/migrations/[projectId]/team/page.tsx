import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { BuyInScreen } from './buy-in-screen';

export const metadata = { title: 'What changes for your team' };

/**
 * BUY-IN for the accounting team (spec §12, board O-buy-in): what stays, what's automated,
 * where things moved, what's new, time saved from this client's own volumes, the words that
 * changed, and a first-week checklist that runs on the real client. journal_entries:view.
 */
export default async function TeamGuidePage({ params }: { params: { projectId: string } }) {
  await requirePagePermission('journal_entries', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading the team guide…</p>}>
      <BuyInScreen projectId={params.projectId} />
    </Suspense>
  );
}
