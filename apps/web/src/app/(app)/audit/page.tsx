import { requirePagePermission } from '@/lib/rbac/page-guard';
import { AuditClient } from './audit-client';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view the audit trail
  // reach this screen; everyone else is redirected. Fails closed. Within the
  // screen the admin-only content gate and the /api/audit route continue to apply.
  await requirePagePermission('audit_trail', 'view');
  return <AuditClient />;
}
