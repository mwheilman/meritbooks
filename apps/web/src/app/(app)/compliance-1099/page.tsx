import { requirePagePermission } from '@/lib/rbac/page-guard';
import { Compliance1099Client } from './compliance-1099-client';

export const dynamic = 'force-dynamic';

export default async function Compliance1099Page() {
  // PAGE-LEVEL RBAC (identity gate #9). 1099 readiness exposes vendor tax facts
  // (TIN presence, W-9 status) and payment totals — gate it on Compliance:view.
  // Fails closed; the GET/POST routes enforce the same guard independently.
  await requirePagePermission('compliance', 'view');
  return <Compliance1099Client />;
}
