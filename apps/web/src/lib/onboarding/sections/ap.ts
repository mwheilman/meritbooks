/**
 * Vendors & A/P — onboarding SECTION descriptor (pure, isomorphic).
 *
 * The payables mirror of sections/ar.ts. Self-describing module the shell + the
 * Setup-Home board render for the vendors/payables domain (design spec §6, §3). Same
 * propose → review → validate → commit contract; the server verbs live in
 * app/api/onboarding/import/ap/route.ts driven by lib/onboarding/import/ap.ts, and the
 * ReviewComponent (client) is components/onboarding/sections/ap-review.tsx keyed on
 * this section's `key`.
 *
 * PURE: no React, no I/O. Reuses the relaxed `OnboardingDomainSection` type from
 * sections/ar.ts to compose without widening the Wave-0 closed unions.
 */

import type { OnboardingStatus, SectionStatusValue } from '@/lib/onboarding/status';
import type { SetupHomeDomain } from '@/lib/onboarding/sections/setup-home';
import { deriveBoardCardStatus } from '@/components/onboarding/helpers';
import { Store } from 'lucide-react';
import type { OnboardingDomainSection } from '@/lib/onboarding/sections/ar';
import { validateApProposal, type ApImportProposal } from '@/lib/onboarding/import/ap';

/**
 * Optional live-count extensions (reported to the lead alongside the AR counts). Absent
 * → the section degrades to not_started.
 */
type ApCounts = OnboardingStatus['counts'] & { vendors?: number; openApBills?: number };

function apCounts(status: OnboardingStatus): ApCounts {
  return status.counts as ApCounts;
}

/** The Vendors & A/P onboarding section. */
export const apSection: OnboardingDomainSection<ApImportProposal> = {
  key: 'vendors_ap',
  label: 'Vendors & A/P',
  icon: Store,
  tone: 'recommended',
  domainKind: 'vendors_ap',
  importSources: ['erp', 'csv', 'manual'],
  skippable: true,
  href: '/onboarding/sections/vendors-ap',
  deriveStatus: (status) => {
    const c = apCounts(status);
    if ((c.openApBills ?? 0) > 0) return 'done';
    if ((c.vendors ?? 0) > 0) return 'in_progress';
    return 'not_started';
  },
  validate: (proposal) => ({ blockers: validateApProposal(proposal) }),
};

/** The Setup-Home board card for Vendors & A/P (long-tail domain, spec §3). */
export const apBoardDescriptor: SetupHomeDomain = {
  key: 'vendors_ap',
  title: 'Vendors & A/P',
  description:
    'Bring in vendors and open payables — they foot to the A/P control before go-live.',
  href: '/onboarding/sections/vendors-ap',
  deriveStatus: (status) => {
    const c = apCounts(status);
    return deriveBoardCardStatus({
      done: (c.openApBills ?? 0) > 0,
      detected: (c.vendors ?? 0) > 0,
    });
  },
};
