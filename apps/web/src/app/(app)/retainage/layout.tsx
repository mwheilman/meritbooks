import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'Retainage' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `bills:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * The retainage register is AP sub-ledger data and the page releases retainage
 * (money out). The release itself is separately gated server-side (requireMoneyMovement
 * on POST /api/retainage).
 */
export default async function RetainageLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('bills', 'view');
  return <>{children}</>;
}
