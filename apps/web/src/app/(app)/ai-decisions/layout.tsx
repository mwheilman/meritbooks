import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const metadata = { title: 'AI decision log' };

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `audit_trail:view` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * The AI decision log is an audit record of every automated decision.
 */
export default async function AiDecisionsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('audit_trail', 'view');
  return <>{children}</>;
}
