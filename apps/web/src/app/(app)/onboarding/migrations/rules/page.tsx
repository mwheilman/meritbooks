import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { RulesScreen } from './rules-screen';

export const metadata = { title: 'Mapping rules' };

/**
 * MAPPING-SET LIBRARY (spec §7.2, O26, part 1): the firm's remembered account matches,
 * evidence per client, conflicts first, settle once for every client. journal_entries:view
 * to read; settling needs chart_of_accounts:approve (the API enforces it).
 */
export default async function MappingRulesPage() {
  await requirePagePermission('journal_entries', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading the rules…</p>}>
      <RulesScreen />
    </Suspense>
  );
}
