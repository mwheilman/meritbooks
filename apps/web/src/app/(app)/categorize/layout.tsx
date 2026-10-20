import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `journal_entries:create` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * The AI Categorizer is a manual coding lane whose output is posted as a journal
 * entry. It also lacked a CompanyScopeGuard (06 §5), so a coding could land on the wrong
 * company; it is wrapped here. IA-SPEC §7 R0b recommends retiring this page in favour of
 * the bank-feed review lane (keep /api/categorize/learn).
 */
export default async function CategorizeLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('journal_entries', 'create');
  return <CompanyScopeGuard>{children}</CompanyScopeGuard>;
}
