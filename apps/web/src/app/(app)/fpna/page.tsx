import { requirePagePermission } from '@/lib/rbac/page-guard';
import { FpnaWorkspace } from './fpna-workspace';

export const metadata = { title: 'FP&A' };

export const dynamic = 'force-dynamic';

/**
 * /fpna — the FP&A workspace (Wave 4A, FPB-reports-fpna §4.13), rebuilt on merit-ui over the
 * 3B metric registry, the 3B analytics, the 3A report engine and the 3C chart kit.
 *
 * Tabs: Dashboard (KPI cards from the 123-metric catalog, saved per user, role defaults
 * published and locked by an administrator) · Performance · Budget vs actual · Bridges ·
 * Working capital · Profitability · Group · Leverage & covenants. Every figure is computed on
 * the server, governed for the reader (non-finance: released months only) and drillable.
 *
 * PAGE-LEVEL RBAC: financial-reports view — the same guard as Reports. Every API route
 * re-checks it (publish needs settings_acct:edit; export / add-to-pack need reports:export).
 */
export default async function FpnaPage() {
  await requirePagePermission('reports', 'view');
  return <FpnaWorkspace />;
}
