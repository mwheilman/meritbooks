import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

// Tab title: "Revenue recognition · Merit Books" (root template).
export const metadata = { title: 'Revenue recognition' };

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `invoices:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Revenue recognition previews and posts revenue; posting is separately gated
 * server-side.
 */
export default async function RevRecLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('invoices', 'view');
  return <>{children}</>;
}
