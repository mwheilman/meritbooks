import { requirePagePermission } from '@/lib/rbac/page-guard';
import { BillsClient } from './bills-client';

export const dynamic = 'force-dynamic';

export default async function BillsPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view Bills/AP reach
  // this screen; everyone else is redirected. Fails closed. Route handlers still
  // enforce create/approve independently.
  await requirePagePermission('bills', 'view');
  return <BillsClient />;
}
