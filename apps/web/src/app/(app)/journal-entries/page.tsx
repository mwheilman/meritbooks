import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { JournalEntriesTabs } from './journal-entries-tabs';

export const dynamic = 'force-dynamic';

export default async function JournalEntriesPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view journal entries
  // reach this screen; everyone else is redirected. Fails closed. The gl/post
  // route still enforces the stricter 'post' permission independently.
  await requirePagePermission('journal_entries', 'view');
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <Suspense fallback={null}>
      <JournalEntriesTabs />
    </Suspense>
  );
}
