/**
 * Onboarding SectionDefinition framework + registry (Wave-0 foundation).
 *
 * The historical-conversion pipeline is the reference contract for onboarding:
 *   source → proposal → review → tie-out gate → deterministic commit.
 * This lifts that contract into a self-describing `SectionDefinition` so every setup
 * DOMAIN (company, chart of accounts, opening balances, bank, integrations, team —
 * and, in later waves, AR/AP, debt, leases, jobs/WIP, …) is a file-disjoint module
 * the generic shell renders the same way (see docs/ONBOARDING-DESIGN-SPEC.md §6).
 *
 * This module is PURE and isomorphic (no React runtime, no 'use client', no I/O), so
 * it is importable by the server flow router, the client wizard/checklist, and unit
 * tests alike. UI (the per-section body / ReviewComponent) is supplied by the client
 * shell keyed on `section.key`; here we own the metadata + the single source of truth
 * for a section's derived STATUS.
 *
 * `deriveStatus` is the load-bearing invariant: a section's live-count-derived `done`
 * ALWAYS wins over any stale persisted `onboarding_state.sections[key]` value, so the
 * readiness checklist and the wizard shell can never disagree about what is finished.
 */

import type { ComponentType } from 'react';
import type {
  OnboardingStatus,
  SectionKey,
  SectionStatusValue,
} from '@/lib/onboarding/status';
import { tieOutBlockers, type AssembledOpeningTb } from '@/lib/onboarding/conversion';
import {
  Building2, BookOpen, Scale, Landmark, Plug, Users,
  type LucideIcon,
} from 'lucide-react';
// Long-tail Setup-Home domain sections (Wave-1). Each is authored file-disjoint; the
// registry is where they are wired into the single source of truth. Their concrete
// proposal generics are bridged to SectionDefinition<unknown> at registration (a
// behavior-neutral cast — strictFunctionTypes makes `validate`'s param contravariant).
import { arSection } from './ar';
import { apSection } from './ap';
import { WIP_SECTION } from './wip';
import { debtSection } from './debt';
import { leasesSection } from './leases';
import { fixedAssetsSection } from './fixed-assets';
import { EQUITY_SECTION } from './equity';

/** How urgently a section is nudged. `required` gates go-live; the rest never nag. */
export type SectionTone = 'required' | 'recommended' | 'optional';

/** A stable domain identifier (proposals/commits key off this). */
export type DomainKind =
  | 'company' | 'chart_of_accounts' | 'opening_balances' | 'bank' | 'integrations' | 'team'
  // Long-tail Setup-Home domains (Wave-1).
  | 'customers_ar' | 'vendors_ap' | 'jobs_wip' | 'debt' | 'leases' | 'fixed_assets' | 'equity';

/** Where a section's facts can come from. Degrade-safe: `manual` always works. */
export type ImportSource = 'erp' | 'document' | 'csv' | 'manual';

/**
 * Props every section body/ReviewComponent receives from the generic shell. Kept
 * intentionally small in Wave 0 (the existing step components read what they need
 * from it); Wave-1 sections lean on the same context for propose/validate/commit.
 */
export interface SectionShellContext {
  status: OnboardingStatus | null;
}

/** The result of validating a section's staged proposal — empty blockers ⇒ ready. */
export interface SectionValidation {
  blockers: string[];
}

/**
 * A self-describing onboarding section. The pipeline verbs (propose/validate/commit)
 * and the ReviewComponent are OPTIONAL in Wave 0 — the existing steps are wrapped by
 * the shell and keep their own logic — and are populated per-domain as later waves
 * lift each step onto the full contract. `deriveStatus` is always present: it is the
 * shared source of truth the checklist and shell both read.
 */
export interface SectionDefinition<TProposal = unknown> {
  /** Stable key; matches the wizard step key and the persisted section-status key. */
  key: SectionKey;
  label: string;
  icon: LucideIcon;
  tone: SectionTone;
  domainKind: DomainKind;
  /** Import paths this domain accepts, best → fallback. (readonly so `as const` section
   *  objects — e.g. the equity descriptor — register without a copy.) */
  importSources: readonly ImportSource[];
  /** True when a user may skip this section without blocking go-live. */
  skippable: boolean;
  /** Deep-link target when the section is surfaced outside the wizard flow. */
  href: string;
  /**
   * Whether the section does not apply to this tenant. Either a predicate over live
   * status (flow/first-class sections — e.g. WIP is n/a off a %-completion method), or
   * a static capability flag (`true` = "no debt / no leases" is a valid answer for the
   * long-tail drop-and-parse domains). */
  notApplicable?: boolean | ((status: OnboardingStatus) => boolean);

  /**
   * The single source of truth for this section's status. A live-count-derived
   * `done` wins over the persisted hint; otherwise the persisted status is used;
   * otherwise `not_started`. Pure and total.
   */
  deriveStatus: (status: OnboardingStatus) => SectionStatusValue;

  // ── Pipeline verbs (Wave-1+; opening already binds `validate`). ──────────────
  /** Stage a proposal for this domain (source → proposal). Wave-1+. */
  propose?: (ctx: SectionShellContext) => Promise<TProposal> | TProposal;
  /** Deterministic gate: reasons the proposal cannot yet be committed. */
  validate?: (proposal: TProposal) => SectionValidation;
  /** Commit through the deterministic engine (tie-out-gated, idempotent). Wave-1+. */
  commit?: (ctx: SectionShellContext, proposal: TProposal) => Promise<void>;
  /** The section's own review UI, when a Wave-1+ section self-contains it. */
  ReviewComponent?: ComponentType<SectionShellContext>;
}

/**
 * Resolve a section's status from live counts (authoritative when `done`) then the
 * persisted hint then `not_started`. `liveDone` returns true when the domain is
 * satisfied by real tenant state; undefined when there is no count signal (e.g. an
 * integration we can't detect), in which case the persisted hint governs.
 */
function resolveStatus(
  key: SectionKey,
  status: OnboardingStatus,
  liveDone: boolean | undefined,
): SectionStatusValue {
  if (liveDone === true) return 'done';
  const stored = status.sections?.[key]?.status;
  if (stored) return stored;
  return 'not_started';
}

/**
 * The registry. Order mirrors the inaugural wizard flow. Icons/labels are the SAME
 * values the wizard renders, so sourcing them here changes nothing visually while
 * making the registry the metadata source of truth.
 *
 * `deriveStatus` bodies lift the exact live-count logic that used to live inline in
 * `readiness-checklist.tsx buildItems()`.
 */
export const ONBOARDING_SECTIONS: readonly SectionDefinition[] = [
  {
    key: 'welcome',
    label: 'Company',
    icon: Building2,
    tone: 'required',
    domainKind: 'company',
    importSources: ['erp', 'manual'],
    skippable: false,
    href: '/onboarding',
    deriveStatus: (s) => resolveStatus('welcome', s, s.counts.entities > 0),
  },
  {
    key: 'coa',
    label: 'Chart of Accounts',
    icon: BookOpen,
    tone: 'required',
    domainKind: 'chart_of_accounts',
    importSources: ['erp', 'csv', 'manual'],
    skippable: false,
    href: '/chart-of-accounts',
    deriveStatus: (s) => resolveStatus('coa', s, s.counts.accounts > 0),
  },
  {
    key: 'opening',
    label: 'Opening Balances',
    icon: Scale,
    tone: 'required',
    domainKind: 'opening_balances',
    importSources: ['erp', 'csv', 'manual'],
    skippable: true, // a brand-new business with no history starts clean
    href: '/onboarding/conversion',
    deriveStatus: (s) => resolveStatus('opening', s, s.hasOpeningEntry),
    // The opening section IS the reference contract: its tie-out gate is the existing
    // `tieOutBlockers` (validate) and its commit is the gated, balanced OPENING_BALANCE
    // post performed by the conversion route. Wave 0 wires `validate` to the real pure
    // function so the framework's gate is genuine and testable.
    validate: (proposal) => ({ blockers: tieOutBlockers(proposal as AssembledOpeningTb) }),
  },
  {
    key: 'bank',
    label: 'Bank Feed',
    icon: Landmark,
    tone: 'recommended',
    domainKind: 'bank',
    importSources: ['document', 'manual'],
    skippable: true,
    href: '/bank-feed',
    deriveStatus: (s) => resolveStatus('bank', s, s.counts.bankAccounts > 0),
  },
  {
    key: 'erp',
    label: 'Connect Systems',
    icon: Plug,
    tone: 'optional',
    domainKind: 'integrations',
    importSources: ['erp'],
    skippable: true,
    href: '/integrations/erp',
    // No live-count signal for a connected system yet → the persisted hint governs.
    deriveStatus: (s) => resolveStatus('erp', s, undefined),
  },
  {
    key: 'team',
    label: 'Team',
    icon: Users,
    tone: 'optional',
    domainKind: 'team',
    importSources: ['manual'],
    skippable: true,
    href: '/team',
    // "Done" once at least one teammate beyond the founding user has been added.
    deriveStatus: (s) => resolveStatus('team', s, s.counts.teamMembers > 1),
  },
  // ── Long-tail Setup-Home domains (Wave-1) ─────────────────────────────────────
  // Registered here as the single source of truth for status; they do NOT render as
  // wizard steps (see WIZARD_FLOW_SECTIONS) — they surface on the Setup Home board.
  // The concrete-proposal generics are bridged to SectionDefinition<unknown> — a
  // behavior-neutral cast forced only by `validate`'s contravariant parameter under
  // strictFunctionTypes; the runtime object is unchanged.
  arSection as SectionDefinition,
  apSection as SectionDefinition,
  WIP_SECTION as SectionDefinition,
  debtSection,
  leasesSection,
  fixedAssetsSection,
  EQUITY_SECTION as SectionDefinition,
];

/**
 * The inaugural WIZARD FLOW sections, in flow order (company · COA · opening · bank ·
 * connect-systems · team). These are the ones the Stepper renders (each has a body in
 * the shell) and the readiness checklist treats as jumpable steps. The long-tail
 * domains above are excluded — they live on the Setup Home board, never the flow. */
const WIZARD_FLOW_KEYS: readonly SectionKey[] = ['welcome', 'coa', 'opening', 'bank', 'erp', 'team'];
export const WIZARD_FLOW_SECTIONS: readonly SectionDefinition[] =
  ONBOARDING_SECTIONS.filter((s) => WIZARD_FLOW_KEYS.includes(s.key));

/** Look up a section definition by key. */
export function getSection(key: SectionKey): SectionDefinition | undefined {
  return ONBOARDING_SECTIONS.find((s) => s.key === key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Books health — "Ready to operate" (required tier) vs "Fully set up" (optional).
//
// Readiness is reframed from "steps remaining" to books health (design spec §3):
// only three things gate go-live — a company exists, opening balances tie out, and a
// revenue-recognition method is chosen. Everything else is optional and renders
// neutral (never a red nag).
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthCriterion {
  key: 'company' | 'opening' | 'revrec';
  label: string;
  detail: string;
  done: boolean;
}

/**
 * The three criteria that gate "ready to operate". Rev-rec is chosen at company
 * creation (every company create requires a `rev_rec_method`), so it derives `done`
 * once a company exists — no separate wizard step. Pure and total.
 */
export function readyToOperateCriteria(status: OnboardingStatus): HealthCriterion[] {
  const hasCompany = status.counts.entities > 0;
  // A clean-start business posts no opening entry — an explicitly skipped/N-A opening
  // section satisfies the gate just as a tied-out posted entry does.
  const openingSkipped = status.sections?.opening?.status === 'skipped'
    || status.sections?.opening?.status === 'n_a';
  const openingDone = status.hasOpeningEntry || openingSkipped;
  return [
    {
      key: 'company',
      label: 'Company created',
      detail: hasCompany ? 'Your book of record exists' : 'Create your first company',
      done: hasCompany,
    },
    {
      key: 'opening',
      label: 'Opening balances tied out',
      detail: status.hasOpeningEntry
        ? 'A balanced opening entry is posted'
        : openingSkipped ? 'Clean start — no prior balances' : 'Convert prior books, or start clean',
      done: openingDone,
    },
    {
      key: 'revrec',
      label: 'Revenue recognition method chosen',
      detail: hasCompany ? 'Set when the company was created' : 'Chosen when you create a company',
      done: hasCompany,
    },
  ];
}

/**
 * Go-live-ready ⇔ every REQUIRED criterion is done. This is the predicate the shell
 * celebrates at 100% and the gate later waves consult before flipping "complete".
 * (Opening balances are `skippable` for a clean-start business, but the tie-out gate
 * still governs the POST; here "done" means a balanced opening entry exists.)
 */
export function goLiveReady(status: OnboardingStatus): boolean {
  return readyToOperateCriteria(status).every((c) => c.done);
}
