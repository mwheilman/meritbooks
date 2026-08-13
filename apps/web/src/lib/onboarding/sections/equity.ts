/**
 * Equity / Cap-table onboarding SECTION (Wave-1).
 *
 * Captures a company's OWNERSHIP — owners/members, ownership % (or units/shares),
 * capital contributed, class, and preferred terms — from a dropped operating
 * agreement / cap-table PDF (parse), a CSV, or manual entry, so a holding-company
 * structure and the CONSOLIDATION ownership are set on day one. Equity has no page
 * of its own today; this section is its home (design spec §3 — an optional Setup
 * Home domain, never a go-live gate).
 *
 * This module is PURE and isomorphic (no React, no I/O) exactly like the registry:
 *   • `EQUITY_SECTION` — the self-describing SectionDefinition-shaped descriptor
 *     (tone `recommended`, skippable, n/a for a single-member entity). The pipeline
 *     verbs live server-side (the API route + `equity-import/*`); `validate` here is
 *     the pure deterministic gate the shell reads.
 *   • `EQUITY_BOARD_DOMAIN` — the Setup Home board card descriptor.
 *
 * INTEGRATION (for the lead — this file does NOT edit registry.ts or setup-home.ts):
 *   • To slot EQUITY_SECTION into `ONBOARDING_SECTIONS`, widen `SectionKey`/
 *     `SECTION_KEYS` (status.ts) with `'equity'` and `DomainKind` (registry.ts) with
 *     `'equity'`; then the object below type-checks as a `SectionDefinition`.
 *   • To show the card, append `EQUITY_BOARD_DOMAIN` to `SETUP_HOME_DOMAINS`.
 *   • The review UI is `components/onboarding/equity-review.tsx` (client) — wire it
 *     as the section body / board deep-link target (`/onboarding/sections/equity`).
 */

import { Scale } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OnboardingStatus, SectionStatusValue } from '@/lib/onboarding/status';
import type { SectionDefinition } from '@/lib/onboarding/sections/registry';
import type { SetupHomeDomain } from './setup-home';
import type { BoardCardStatus } from '@/components/onboarding/helpers';
import { deriveBoardCardStatus } from '@/components/onboarding/helpers';
import { capTableBlockers } from '@/lib/onboarding/equity-import/normalize';
import type { ProposedOwner, OwnershipBasis } from '@/lib/onboarding/equity-import/types';

/** Stable key for the equity section (add to SectionKey to slot into the registry). */
export const EQUITY_SECTION_KEY = 'equity' as const;

/** The proposal shape the equity section validates/commits. */
export interface EquityProposal {
  owners: ProposedOwner[];
  ownershipBasis: OwnershipBasis;
}

/** Reasons the cap table cannot yet be committed — empty ⇒ ready. */
export function equitySectionValidate(proposal: EquityProposal): { blockers: string[] } {
  return { blockers: capTableBlockers(proposal) };
}

/**
 * Read the persisted equity section hint from the (loosely-typed) sections map. The
 * map is keyed by the core SectionKey union which doesn't yet include 'equity', so
 * we read it defensively; once the lead widens SECTION_KEYS this stays correct.
 */
function persistedEquityStatus(status: OnboardingStatus): SectionStatusValue | undefined {
  const sections = status.sections as Record<string, { status?: SectionStatusValue }> | undefined;
  return sections?.[EQUITY_SECTION_KEY]?.status;
}

/**
 * Derive the equity section status. There is no first-class live-count signal for
 * cap-table holders yet, so callers that HAVE a holder count pass it in (authoritative
 * `done`); otherwise the persisted hint governs, else `not_started`. Pure and total.
 */
export function deriveEquityStatus(
  status: OnboardingStatus,
  holderCount?: number,
): SectionStatusValue {
  if (holderCount !== undefined && holderCount > 0) return 'done';
  return persistedEquityStatus(status) ?? 'not_started';
}

/**
 * N/A for a single-member entity (one owner owning 100%) — a solo LLC has no cap
 * table to speak of. Detectable only from a persisted `n_a` hint today; a caller with
 * a live holder count can pass it to make the call concrete. Pure and total.
 */
export function equityNotApplicable(status: OnboardingStatus, holderCount?: number): boolean {
  if (holderCount !== undefined) return holderCount <= 1 && persistedEquityStatus(status) === 'n_a';
  return persistedEquityStatus(status) === 'n_a';
}

/**
 * The equity SectionDefinition, shaped to the registry's contract. Its `key` is a
 * string literal (widen SectionKey to `include 'equity'` to add it to the registry
 * array). Deliberately mirrors the registry's field set so it is a drop-in.
 */
export const EQUITY_SECTION: SectionDefinition<EquityProposal> = {
  key: EQUITY_SECTION_KEY,
  label: 'Equity & Cap Table',
  icon: Scale as LucideIcon,
  tone: 'recommended',
  domainKind: 'equity',
  importSources: ['document', 'csv', 'manual'],
  skippable: true,
  href: '/onboarding/sections/equity',
  notApplicable: (s: OnboardingStatus) => equityNotApplicable(s),
  deriveStatus: (s: OnboardingStatus) => deriveEquityStatus(s),
  validate: (proposal: EquityProposal) => equitySectionValidate(proposal),
};

/** The Setup Home board card descriptor (append to SETUP_HOME_DOMAINS). */
export const EQUITY_BOARD_DOMAIN: SetupHomeDomain = {
  key: 'equity',
  title: 'Equity & cap table',
  description:
    'Drop an operating agreement or cap table — we propose owners, ownership %, and capital, and wire the consolidation ownership.',
  href: '/onboarding/sections/equity',
  deriveStatus: (): BoardCardStatus => deriveBoardCardStatus({}),
};
