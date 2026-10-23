import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'Operations' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `team:manage` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * The operations overview was gated only in the browser (canManageUsers). This is
 * the closest page-level key; /api/operations enforces canManageUsers server-side.
 */
export default async function OperationsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('team', 'manage');
  return <>{children}</>;
}
