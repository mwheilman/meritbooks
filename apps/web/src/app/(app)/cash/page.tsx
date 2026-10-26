import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CashWorkspace } from './cash-workspace';

export const metadata = { title: 'Cash' };

/**
 * CASH (Wave 4C, docs/FPB-reports-fpna.md §4.12) — position now, the direct 13-week forecast
 * (scenarios, daily drill, band, minimum cash, recommendations), scenarios & manual items,
 * forecast accuracy, and per-company cash settings. Built on merit-ui.
 *
 * Page-level RBAC: cash_position:view (fails closed before any client JS). The forecast, scenario
 * and settings routes check cash.forecast view / edit themselves. Viewing supports "All companies"
 * (a read-only consolidated analysis — intercompany excluded); every write names one company.
 */
export default async function CashPage() {
  await requirePagePermission('cash_position', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading cash…</p>}>
      <CashWorkspace />
    </Suspense>
  );
}
