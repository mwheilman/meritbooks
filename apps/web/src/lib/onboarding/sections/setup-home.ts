/**
 * Setup Home board — the optional "long tail" domain metadata (design spec §3).
 *
 * The critical path (company · COA · opening balances) gates go-live and is owned by
 * the wizard flow + the `ONBOARDING_SECTIONS` registry. EVERYTHING else — AR/AP,
 * jobs/WIP, debt, leases, fixed assets, equity, tax — is optional and lives on the
 * Setup Home board as a card in one of Done / Detected / Add-later. These domains do
 * NOT gate anything and never nag.
 *
 * This module is PURE (no React, no I/O): it's the shared descriptor list + the
 * live-state → board-status derivation the board renders. Each domain deep-links to
 * its EXISTING surface (those pages already exist); nothing here rebuilds a domain.
 *
 * DETECTION IS A PLACEHOLDER pending the later domain-section wave: an import that
 * finds "2 loans" would flip debt to `detected`. Until those sections write a
 * detection signal into `onboarding_state.sections`, long-tail domains derive `done`
 * from live tenant counts where a count exists, else fall to the neutral `add-later`.
 */

import type { OnboardingStatus } from '@/lib/onboarding/status';
import type { BoardCardStatus } from '@/components/onboarding/helpers';
import { deriveBoardCardStatus } from '@/components/onboarding/helpers';

/** A long-tail domain shown on the Setup Home board. */
export interface SetupHomeDomain {
  key: string;
  title: string;
  /** Plain-language description / next action. */
  description: string;
  /** Deep-link to the domain's existing surface. */
  href: string;
  /**
   * Derive this domain's board status from live tenant state. Pure. Defaults to the
   * neutral `add-later` when there is no live signal yet (the common case today).
   */
  deriveStatus: (status: OnboardingStatus) => BoardCardStatus;
}

/**
 * The optional domains, in a sensible board order. `deriveStatus` leans on live
 * counts where the status object already exposes one; otherwise it returns the
 * neutral `add-later`. (Deeper per-domain detection lands with the domain sections.)
 */
export const SETUP_HOME_DOMAINS: readonly SetupHomeDomain[] = [
  {
    key: 'customers_ar',
    title: 'Customers & A/R',
    description: 'Bring in your customer list and open receivables — they foot to the A/R control.',
    href: '/customers',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'vendors_ap',
    title: 'Vendors & A/P',
    description: 'Bring in vendors and open payables — they foot to the A/P control.',
    href: '/vendors',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'jobs_wip',
    title: 'Jobs & WIP',
    description: 'Contracts, budgets, costs-to-date — we build the schedule and tie it to the ledger.',
    href: '/jobs',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'debt',
    title: 'Debt & loans',
    description: 'Drop a loan agreement and we build the amortization schedule + covenants.',
    href: '/debt',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'leases',
    title: 'Leases',
    description: 'Drop a lease PDF for the ROU asset and lease liability (ASC 842).',
    href: '/leases',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'fixed_assets',
    title: 'Fixed assets',
    description: 'Drop a register or capex invoices to build depreciation.',
    href: '/fixed-assets',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'sales_tax',
    title: 'Sales tax',
    description: 'Register jurisdictions and filing frequency when you owe sales tax.',
    href: '/sales-tax-calendar',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
  {
    key: 'insurance',
    title: 'Insurance',
    description: 'Track policies and coverage — drop a policy to log renewals.',
    href: '/insurance',
    deriveStatus: () => deriveBoardCardStatus({}),
  },
];
