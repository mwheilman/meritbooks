import { PageHeader } from '@/components/ui';
import { FpnaDashboard } from './fpna-dashboard';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * FP&A Dashboard — the native financial-planning command center (Pillar 3).
 *
 * Read-only. KPIs with prior-period deltas, monthly burn + cash runway, an
 * actual-vs-budget-vs-forecast variance table, and 12-month trends — all drawn
 * live from the owned GL (never asserted). Every figure is computed
 * deterministically in `lib/fpna/dashboard.ts`, reusing the same account-type
 * math as the financial statements, so the dashboard can't disagree with them.
 *
 * PAGE-LEVEL RBAC (identity gate #9): gated on the financial-reports view
 * permission — the same guard the Reports and Profitability surfaces use. Fails
 * closed (redirect) for any role that may not read financial statements.
 */
export default async function FpnaDashboardPage() {
  await requirePagePermission('reports', 'view');
  return (
    <>
      <PageHeader
        title="FP&A Dashboard"
        description="KPIs, cash runway, plan variance, and trends — read live from the books, not asserted."
      />
      <FpnaDashboard />
    </>
  );
}
