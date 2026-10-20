import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `settings_acct:edit` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Onboarding setup sections (debt, equity, fixed assets, leases) — same gate as
 * /onboarding.
 */
export default async function OnboardingSectionsLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('settings_acct', 'edit');
  return <>{children}</>;
}
