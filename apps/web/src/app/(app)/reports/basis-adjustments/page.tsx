import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { BasisAdjustmentsManager } from './manager';

export const dynamic = 'force-dynamic';

/**
 * Reporting-basis adjustments manager. Defining how a statement is re-presented on a TAX /
 * CASH / CUSTOM basis is a reporting-control action, so it sits behind the same guard the
 * book-to-tax tagging surface uses (journal_entries:create). These rows are presentation
 * overlays — they NEVER post to the GL; the accrual ledger stays the single book of record.
 */
export default async function BasisAdjustmentsPage() {
  await requirePagePermission('journal_entries', 'create');
  return (
    <>
      <PageHeader
        title="Reporting-Basis Adjustments"
        description="Present the P&L, Balance Sheet, and Trial Balance on a Tax, Cash, or Custom basis by layering per-account adjustments on top of the GAAP (accrual) statements. These are report-presentation deltas — they never post to the general ledger, which stays accrual. For the Tax basis, derive the adjustments straight from your Book-to-Tax M-1 differences so nothing is hand-keyed. A valid basis presentation nets to zero across accounts; an imbalance is flagged, never silently forced."
      />
      <BasisAdjustmentsManager />
    </>
  );
}
