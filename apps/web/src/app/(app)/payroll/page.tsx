import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PayrollClient } from './payroll-client';

export const dynamic = 'force-dynamic';

export default async function PayrollPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Payroll is a sensitive money-movement +
  // PII-adjacent surface — only roles that may view Payroll reach this screen;
  // everyone else is redirected. Fails closed. The run/approve/release routes
  // enforce their own permission + preparer≠approver checks independently.
  await requirePagePermission('payroll', 'view');
  return <PayrollClient />;
}
