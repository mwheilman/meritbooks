import type { ReactNode } from 'react';
import { requireBudgetsPageAccess } from '@/lib/budgets/page-access';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `forecast:view` are redirected
 * before any client JS ships — EXCEPT department budget owners (Wave 4B), who may enter to build
 * and explain their own departments; the budget API scopes them to those departments. Fails
 * closed. Replaced by the capability-registry guard (fpa.budgets:view) in IA wave 1.
 *
 * Budgets, drivers and reforecasts (FP&A). Covers every budgets sub-page.
 */
export default async function BudgetsLayout({ children }: { children: ReactNode }) {
  await requireBudgetsPageAccess();
  return <>{children}</>;
}
