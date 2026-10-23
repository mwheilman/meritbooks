import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'Search' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `dashboard:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Global search spans every internal record; internal roles only.
 */
export default async function SearchLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('dashboard', 'view');
  return <>{children}</>;
}
