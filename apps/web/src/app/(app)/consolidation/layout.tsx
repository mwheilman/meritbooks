import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'Consolidation' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `reports:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Consolidated statements across the entity group. The APIs behind it now carry
 * the same reports:view check server-side.
 */
export default async function ConsolidationLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('reports', 'view');
  return <>{children}</>;
}
