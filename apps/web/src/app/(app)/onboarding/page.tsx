import { requirePagePermission } from '@/lib/rbac/page-guard';
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
 */
export default async function OnboardingPage() {
  await requirePagePermission('settings_acct', 'edit');
  return <OnboardingWizard />;
}
