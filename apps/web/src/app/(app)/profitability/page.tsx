import { PageHeader } from '@/components/ui';
import { ProfitabilityBoard } from './profitability-board';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * Portfolio Profitability — the practice-partner surface for per-entity/per-client
 * profitability (accounting-firm-partner brief B9). One P&L per entity for a period
 * plus a portfolio roll-up, ranked, drawn entirely from the live GL.
 *
 * PAGE-LEVEL RBAC (identity gate #9): gated on the financial-reports view
 * permission — only roles that may read financial statements reach this cross-entity
 * P&L. Fails closed (redirect) for everyone else.
 */
export default async function ProfitabilityPage() {
  await requirePagePermission('reports', 'view');
  return (
    <>
      <PageHeader
        title="Entity Profitability"
        description="Per-entity P&L and margin for the period — ranked, and derived from the books, not asserted."
      />
      <ProfitabilityBoard />
    </>
  );
}
