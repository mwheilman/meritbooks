import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PoClient } from './po-client';

export const dynamic = 'force-dynamic';

export default async function PurchaseOrdersPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Purchase orders are an AP commitment, so
  // they gate behind the same `bills` (AP) permission as the Bills screen. Route
  // handlers re-enforce create/receive/match independently. Fails closed.
  await requirePagePermission('bills', 'view');
  return <PoClient />;
}
