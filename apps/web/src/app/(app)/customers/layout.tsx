import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'Customers' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `customers:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Customer master data.
 */
export default async function CustomersLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('customers', 'view');
  return <>{children}</>;
}
