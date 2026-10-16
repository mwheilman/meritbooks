import { requirePagePermission } from '@/lib/rbac/page-guard';
import { requirePreparerCapabilityPage } from '@/lib/team/admin-scope-guard';
import { PortfolioOnboarding } from './portfolio-onboarding';

export const dynamic = 'force-dynamic';

/**
 * Portfolio onboarding — "many companies = one motion" (FPB-onboarding principle 9).
 *
 * For tenants bringing many companies onto MeritBooks at once (a group of operating
 * companies, an accounting firm's clients): bulk-add companies, drop every trial
 * balance in one go (each file matched to its company), and watch them all move to
 * "live" on the Control Tower.
 *
 * Same gates as the onboarding wizard: settings_acct:edit (standing up a book of
 * record), and the delegated-admin preparer gate (management-only admins are steered
 * to Team). Every API route behind this page re-checks settings_acct:edit.
 */
export default async function PortfolioOnboardingPage() {
  await requirePagePermission('settings_acct', 'edit');
  await requirePreparerCapabilityPage('/team');
  return <PortfolioOnboarding />;
}
