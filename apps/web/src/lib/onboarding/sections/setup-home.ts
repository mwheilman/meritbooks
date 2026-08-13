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
// The real, live-state-deriving board descriptors exported by each Wave-1 section
// module (they supersede the Wave-0 placeholders below).
import { arBoardDescriptor } from './ar';
import { apBoardDescriptor } from './ap';
import { WIP_SETUP_HOME_DOMAIN } from './wip';
import { debtBoardDescriptor } from './debt';
import { leasesBoardDescriptor } from './leases';
import { fixedAssetsBoardDescriptor } from './fixed-assets';
import { EQUITY_BOARD_DOMAIN } from './equity';

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
  // Wave-1 domains — the real descriptors derive Done/Detected from live tenant state
  // (counts) + the persisted detection hint, and deep-link to the onboarding section
  // host that mounts each domain's ReviewComponent.
  arBoardDescriptor,
  apBoardDescriptor,
  WIP_SETUP_HOME_DOMAIN,
  debtBoardDescriptor,
  leasesBoardDescriptor,
  fixedAssetsBoardDescriptor,
  EQUITY_BOARD_DOMAIN,
  // Still-placeholder long-tail domains (no dedicated section module yet).
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
