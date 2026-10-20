import type { ReactNode } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). Server-side guard
 * for this route segment (and any sub-pages): callers without `settings_acct:edit` are redirected
 * before any client JS ships. Fails closed. Replaced by the capability-registry guard in
 * IA wave 1.
 *
 * Onboarding conversion — same gate as /onboarding and /onboarding/portfolio.
 */
export default async function OnboardingConversionLayout({ children }: { children: ReactNode }) {
  await requirePagePermission('settings_acct', 'edit');
  return <>{children}</>;
}
