import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { requirePreparerCapabilityPage } from '@/lib/team/admin-scope-guard';
import { resolveOnboardingFlow } from '@/lib/onboarding/flow';
import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

/**
 * The unified inaugural onboarding wizard — a single guided flow that stitches the
 * existing setup pieces (entity create, COA seed, historical opening-balance
 * conversion, Plaid bank connect, team invites) into one first-run experience that
 * ends with a balanced go-live and the tenant marked onboarded.
 *
 * Gated on settings_acct:edit — standing up a book of record is a company_admin /
 * accounting-settings action (mirrors the Add-Company wizard). A returning admin
 * can re-enter here from Settings → Companies at any time.
 *
 * DELEGATED-ADMIN GATE: running onboarding/data entry is a PREPARER responsibility.
 * A MANAGEMENT-only admin (who invites/oversees but delegates the books) is steered
 * to Team instead. Fail-open: absent/unrestricted scope keeps full access — no
 * lockout, including before the admin_scope migration lands.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  // COMPANY-STATE ROUTER: decide the flow from the company's state, not the user's
  // role. A brand-new member on an already-live company is sent to the guided tour
  // instead of a setup surface they'd be bounced out of. `setup`/`live` fall through
  // to the existing guards below, so first-run and admin behavior is unchanged.
  // Fail-safe (unresolved org / any error) resolves to `live` — never the tour.
  const flow = await resolveOnboardingFlow(searchParams);
  if (flow === 'tour') redirect('/onboarding/tour');

  await requirePagePermission('settings_acct', 'edit');
  await requirePreparerCapabilityPage('/team');
  return <OnboardingWizard />;
}
