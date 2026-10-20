import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `forecast:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Budgets, drivers and reforecasts (FP&A). Covers every budgets sub-page.
 */
export default async function BudgetsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('forecast', 'view');
  return <>{children}</>;
}
