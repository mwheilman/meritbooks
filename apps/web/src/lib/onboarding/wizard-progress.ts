/**
 * Honest wizard progress (FPB-onboarding §2 principle 7: "Skipped steps are shown as
 * skipped, not done"). Pure — the wizard renders exactly what these return, and the
 * tests pin the honesty rules.
 */

import type {
  CompanyOnboarding,
  CompanyOpeningState,
  OnboardingStatus,
  OnboardingStepKey,
  SectionStatusValue,
} from './status';

/** How a step renders in the progress bar. */
export type StepDisplayState = 'done' | 'skipped' | 'current' | 'upcoming';

export interface StepDisplayInput {
  isCurrent: boolean;
  /** The step's real status (live counts / per-company truth). */
  status: SectionStatusValue | 'done';
  /** The user has moved past this step in the flow (it is before the furthest step reached). */
  passed: boolean;
}

/**
 * - current → current
 * - really done → done
 * - explicitly skipped / not applicable, or passed over without being done → skipped
 * - otherwise → upcoming
 * A step is NEVER shown as done merely because the user clicked past it.
 */
export function stepDisplayState(i: StepDisplayInput): StepDisplayState {
  if (i.isCurrent) return 'current';
  if (i.status === 'done') return 'done';
  if (i.status === 'skipped' || i.status === 'n_a') return 'skipped';
  if (i.passed) return 'skipped';
  return 'upcoming';
}

/** Plain-English label for a company's opening-balance state. */
export const OPENING_STATE_LABEL: Record<CompanyOpeningState, string> = {
  not_started: 'Not started',
  started_fresh: 'Started fresh',
  posted: 'Posted',
};

/** The company the wizard is working on, by id (null when absent). */
export function findCompany(status: OnboardingStatus | null, companyId: string | null): CompanyOnboarding | null {
  if (!status?.companies || !companyId) return null;
  return status.companies.find((c) => c.id === companyId) ?? null;
}

/**
 * Pick the company the wizard should focus on: an explicitly preferred one (e.g. just
 * created) when it exists, else the first company that is not yet live, else the first.
 */
export function pickActiveCompanyId(
  companies: Pick<CompanyOnboarding, 'id' | 'live'>[],
  preferred: string | null,
): string | null {
  if (preferred && companies.some((c) => c.id === preferred)) return preferred;
  return companies.find((c) => !c.live)?.id ?? companies[0]?.id ?? null;
}

/** Can the user finish onboarding for this company? Posted balances or an explicit fresh start. */
export function canFinish(company: Pick<CompanyOnboarding, 'opening'> | null): boolean {
  return company?.opening === 'posted' || company?.opening === 'started_fresh';
}

/** Should the wizard open on the setup board (a return visit after go-live)? */
export function opensOnBoard(status: Pick<OnboardingStatus, 'complete' | 'companies'> | null): boolean {
  if (!status) return false;
  return status.complete === true && (status.companies?.length ?? 0) > 0;
}

/** One honest row of the Launch summary. */
export interface LaunchRow {
  key: 'companies' | 'coa' | 'opening' | 'bank' | 'team';
  label: string;
  value: string;
  state: 'done' | 'skipped' | 'not_started';
}

/** Build the Launch summary from REAL state only. Pure. */
export function launchSummary(
  status: OnboardingStatus | null,
  company: CompanyOnboarding | null,
  opts: { accountCount: number; skippedSteps: ReadonlySet<OnboardingStepKey> },
): LaunchRow[] {
  const companies = status?.companies ?? [];
  const liveCount = companies.filter((c) => c.live).length;
  const bank = status?.counts?.bankAccounts ?? 0;
  const team = status?.counts?.teamMembers ?? 0;

  const opening: LaunchRow = company
    ? {
      key: 'opening',
      label: `Opening balances — ${company.name}`,
      value: company.opening === 'posted'
        ? 'Posted — balanced to the penny'
        : company.opening === 'started_fresh'
          ? 'Started fresh — no prior history'
          : 'Not started',
      state: company.opening === 'not_started' ? 'not_started' : 'done',
    }
    : { key: 'opening', label: 'Opening balances', value: 'Not started — create a company first', state: 'not_started' };

  return [
    {
      key: 'companies',
      label: 'Companies',
      value: companies.length === 0
        ? 'None yet'
        : `${companies.length} total · ${liveCount} live`,
      state: companies.length > 0 ? 'done' : 'not_started',
    },
    {
      key: 'coa',
      label: 'Chart of accounts',
      value: opts.accountCount > 0 ? `${opts.accountCount} accounts` : 'Not set up',
      state: opts.accountCount > 0 ? 'done' : 'not_started',
    },
    opening,
    {
      key: 'bank',
      label: 'Bank',
      value: bank > 0
        ? `${bank} account${bank === 1 ? '' : 's'} connected`
        : opts.skippedSteps.has('bank') ? 'Skipped — connect later from Bank Feed' : 'Not connected',
      state: bank > 0 ? 'done' : opts.skippedSteps.has('bank') ? 'skipped' : 'not_started',
    },
    {
      key: 'team',
      label: 'Team',
      value: team > 1
        ? `${team} members`
        : opts.skippedSteps.has('team') ? 'Skipped — just you for now' : 'Just you',
      state: team > 1 ? 'done' : opts.skippedSteps.has('team') ? 'skipped' : 'not_started',
    },
  ];
}
