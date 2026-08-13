/**
 * Customers & A/R — onboarding SECTION descriptor (pure, isomorphic).
 *
 * This is the self-describing module the generic onboarding shell + the Setup-Home
 * board render for the receivables domain (design spec §6). It follows the same
 * propose → review → validate → commit contract as the reference conversion pipeline,
 * but AR/AP live on the optional Setup-Home "long tail" (spec §3) rather than gating
 * go-live — so this exports BOTH a section descriptor (pipeline metadata + the pure
 * `validate` gate) AND a Setup-Home board descriptor.
 *
 * PURE: no React, no I/O. The heavy verbs (propose = pull/normalize; commit = write
 * masters + opening invoices + subledger detail) run server-side in
 * app/api/onboarding/import/ar/route.ts, driven by the pure helpers in
 * lib/onboarding/import/ar.ts. The ReviewComponent is supplied separately (client)
 * and keyed on this section's `key` by the shell — see
 * components/onboarding/sections/ar-review.tsx.
 *
 * `key`/`domainKind` intentionally sit OUTSIDE the Wave-0 closed `SectionKey`/
 * `DomainKind` unions (which the lead owns in status.ts/registry.ts). To avoid editing
 * that reserved Wave-0 surface, this uses a locally-relaxed `OnboardingDomainSection`
 * type; the lead wires registration.
 */

import type { OnboardingStatus } from '@/lib/onboarding/status';
import type { SectionDefinition } from '@/lib/onboarding/sections/registry';
import type { SetupHomeDomain } from '@/lib/onboarding/sections/setup-home';
import { deriveBoardCardStatus } from '@/components/onboarding/helpers';
import { Users } from 'lucide-react';
import { validateArProposal, type ArImportProposal } from '@/lib/onboarding/import/ar';

/**
 * A self-describing onboarding domain section. Reconciled by the lead (integrator) to
 * the real `SectionDefinition` now that `SectionKey`/`DomainKind` include the long-tail
 * domain keys — so AR/AP register into `ONBOARDING_SECTIONS` with no cast at the type
 * level (a behavior-neutral generic bridge happens only at the array literal). */
export type OnboardingDomainSection<TProposal = unknown> = SectionDefinition<TProposal>;

/**
 * Live-count fields this section derives status from. They are OPTIONAL extensions to
 * OnboardingCounts (the base type has no AR/customer signal). Reported to the lead as
 * a small additive widening of OnboardingCounts + loadOnboardingStatus so the board
 * flips to "done" from real tenant state; absent, the section degrades to not_started.
 */
type ArCounts = OnboardingStatus['counts'] & { customers?: number; openArInvoices?: number };

function arCounts(status: OnboardingStatus): ArCounts {
  return status.counts as ArCounts;
}

/** The Customers & A/R onboarding section. */
export const arSection: OnboardingDomainSection<ArImportProposal> = {
  key: 'customers_ar',
  label: 'Customers & A/R',
  icon: Users,
  tone: 'recommended',
  domainKind: 'customers_ar',
  importSources: ['erp', 'csv', 'manual'],
  skippable: true,
  href: '/onboarding/sections/customers-ar',
  deriveStatus: (status) => {
    const c = arCounts(status);
    if ((c.openArInvoices ?? 0) > 0) return 'done';
    if ((c.customers ?? 0) > 0) return 'in_progress';
    return 'not_started';
  },
  validate: (proposal) => ({ blockers: validateArProposal(proposal) }),
};

/** The Setup-Home board card for Customers & A/R (long-tail domain, spec §3). */
export const arBoardDescriptor: SetupHomeDomain = {
  key: 'customers_ar',
  title: 'Customers & A/R',
  description:
    'Bring in your customer list and open receivables — they foot to the A/R control before go-live.',
  href: '/onboarding/sections/customers-ar',
  deriveStatus: (status) => {
    const c = arCounts(status);
    return deriveBoardCardStatus({
      done: (c.openArInvoices ?? 0) > 0,
      detected: (c.customers ?? 0) > 0,
    });
  },
};
