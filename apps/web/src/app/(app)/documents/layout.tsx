import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `audit_trail:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * The document center holds retained source evidence (contracts, statements,
 * W-9s, COIs) behind the books.
 */
export default async function DocumentsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('audit_trail', 'view');
  return <>{children}</>;
}
