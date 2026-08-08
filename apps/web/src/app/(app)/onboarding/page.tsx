import { requirePagePermission } from '@/lib/rbac/page-guard';
import { requirePreparerCapabilityPage } from '@/lib/team/admin-scope-guard';
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
export default async function OnboardingPage() {
  await requirePagePermission('settings_acct', 'edit');
  await requirePreparerCapabilityPage('/team');
  return <OnboardingWizard />;
}
