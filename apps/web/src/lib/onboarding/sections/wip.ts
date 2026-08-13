/**
 * Jobs / WIP onboarding SECTION (PURE, isomorphic — no React runtime, no I/O).
 *
 * The construction-critical, first-class gating domain (design spec §4): for a
 * homebuilder on a %-completion method, the open jobs and their opening WIP position
 * must tie to the GL before go-live. This module is the self-describing
 * `SectionDefinition` the generic onboarding shell renders — its `validate` is the
 * deterministic WIP-import gate; its `deriveStatus`/`notApplicable` are pure and total.
 *
 * The heavy lifting (parse, opening-WIP math, create jobs, stage `subledgerDetail`)
 * lives in `lib/onboarding/wip-import/**` and the import route — this file stays pure
 * and importable by the server flow, the client shell, and unit tests alike (mirrors
 * how the `opening` section wires only its pure `validate`).
 *
 * ── FOR THE LEAD (wiring; nothing here edits registry.ts / status.ts / setup-home.ts) ──
 *   • Export `WIP_SECTION`      → add to `ONBOARDING_SECTIONS` in sections/registry.ts.
 *   • Export `WIP_SETUP_HOME_DOMAIN` → replaces the `jobs_wip` PLACEHOLDER in
 *     sections/setup-home.ts (this one derives real Done/Detected from section state).
 *   • REPORTED (small, no migration): widen `SECTION_KEYS` in status.ts to include
 *     'jobs_wip' (then drop the `as SectionKey` cast below); and, for precise n/a
 *     gating, surface the tenant's rev-rec method(s) on `OnboardingStatus`
 *     (`revRecMethods?: string[]`) — this module reads it defensively already.
 */

import type {
  SectionDefinition,
  SectionValidation,
} from './registry';
import type {
  OnboardingStatus,
  SectionKey,
  SectionStatusValue,
} from '@/lib/onboarding/status';
import type { SetupHomeDomain } from './setup-home';
import { deriveBoardCardStatus, type BoardCardStatus } from '@/components/onboarding/helpers';
import { HardHat } from 'lucide-react';
import { wipImportBlockers, type WipProposal } from '@/lib/onboarding/wip-import';

/** The section key for the jobs/WIP domain (now in the widened SectionKey union). */
export const WIP_SECTION_KEY: SectionKey = 'jobs_wip';
const WIP_KEY: SectionKey = WIP_SECTION_KEY;

/**
 * The rev-rec methods for which the WIP lane APPLIES (accrual %-completion). Any other
 * method (POINT_OF_SALE, AS_BILLED/T&M, CASH, COMPLETED_CONTRACT, SUBSCRIPTION, …) does
 * not accrue interim under/over-billing, so the WIP section is not-applicable.
 * Driven off the method captured in step 1 of onboarding (rev-rec inquiry).
 */
export const WIP_APPLICABLE_METHODS: ReadonlySet<string> = new Set(['PCT_COSTS_INCURRED', 'PCT_COMPLETE']);

/** True when ANY captured rev-rec method is a %-completion method. Pure. */
export function wipApplicableForMethods(methods: readonly string[] | null | undefined): boolean {
  if (!methods || methods.length === 0) return false;
  return methods.some((m) => WIP_APPLICABLE_METHODS.has(String(m).toUpperCase()));
}

/** Defensively read rev-rec methods off the status (present once the lead surfaces them). */
function methodsOf(status: OnboardingStatus): string[] | undefined {
  const m = (status as { revRecMethods?: unknown }).revRecMethods;
  return Array.isArray(m) ? m.map(String) : undefined;
}

/**
 * The WIP section is n/a UNLESS a company uses a %-completion method. When methods are
 * not yet surfaced on the status, we DON'T hide it (return false) — the import route
 * still enforces applicability — so a contractor is never silently locked out.
 */
export function wipNotApplicable(status: OnboardingStatus): boolean {
  const methods = methodsOf(status);
  if (methods === undefined) return false; // unknown → keep visible; route enforces
  return !wipApplicableForMethods(methods);
}

/** Pure status derivation: n/a wins; else the persisted section hint; else not_started. */
export function deriveWipStatus(status: OnboardingStatus): SectionStatusValue {
  if (wipNotApplicable(status)) return 'n_a';
  const stored = status.sections?.[WIP_KEY]?.status;
  return stored ?? 'not_started';
}

/**
 * The self-describing WIP section. `validate` is the deterministic WIP-import gate
 * (day-one-required facts per open job); `propose`/`commit` are performed by the import
 * route (`POST /api/onboarding/import/wip`), mirroring how the `opening` section's
 * commit is performed by the conversion route.
 */
export const WIP_SECTION: SectionDefinition<WipProposal> = {
  key: WIP_KEY,
  label: 'Jobs & WIP',
  // Icon type is LucideIcon; HardHat is the construction-domain glyph.
  icon: HardHat,
  tone: 'recommended',
  domainKind: 'opening_balances', // WIP ties into the opening position (no new domainKind)
  importSources: ['csv', 'document', 'manual'],
  skippable: true,
  href: '/jobs',
  notApplicable: wipNotApplicable,
  deriveStatus: deriveWipStatus,
  validate: (proposal): SectionValidation => ({ blockers: wipImportBlockers(proposal?.jobs ?? []) }),
};

/**
 * Setup-Home board descriptor for the jobs/WIP domain — supersedes the placeholder in
 * setup-home.ts with real Done/Detected derivation from the persisted section status.
 */
export const WIP_SETUP_HOME_DOMAIN: SetupHomeDomain = {
  key: WIP_SECTION_KEY,
  title: 'Jobs & WIP',
  description: 'Contracts, budgets, costs-to-date — we build the schedule and tie the opening WIP to the ledger.',
  // Deep-links to the onboarding section host that mounts WipReview (the shell owns the
  // per-section UI; the review surface itself deep-links to /jobs for the full flow).
  href: '/onboarding/sections/jobs-wip',
  deriveStatus: (status): BoardCardStatus => {
    if (wipNotApplicable(status)) return 'add-later';
    const s = status.sections?.[WIP_KEY]?.status;
    return deriveBoardCardStatus({ done: s === 'done', detected: s === 'in_progress' });
  },
};
