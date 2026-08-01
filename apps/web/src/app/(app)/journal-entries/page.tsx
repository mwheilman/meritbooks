import { requirePagePermission } from '@/lib/rbac/page-guard';
import { JournalEntriesClient } from './je-client';

export const dynamic = 'force-dynamic';

export default async function JournalEntriesPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view journal entries
  // reach this screen; everyone else is redirected. Fails closed. The gl/post
  // route still enforces the stricter 'post' permission independently.
  await requirePagePermission('journal_entries', 'view');
  return <JournalEntriesClient />;
}
