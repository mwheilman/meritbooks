/**
 * Long-tail DOMAIN detection + status derivation for the Setup Home board
 * (design spec §3): Debt, Leases, and Fixed Assets each surface as a card that is
 * Done ✓ / Detected · review / Add later. This is the PURE, isomorphic core those
 * three onboarding sections share — no React, no I/O in the derivation functions —
 * so the board, the section shell, and unit tests all read one source of truth.
 *
 * WRAP, DON'T REBUILD: these domains already own full drop-and-parse + deterministic
 * commit engines (`lib/debt/*`, `lib/leases/*`, `lib/fixed-assets/*`,
 * `lib/covenants/*`). Nothing here touches posting, schemas, or those engines — it
 * only decides what STATE the board card shows and how an importer sets a "detected"
 * hint so the card can light up (e.g. a QuickBooks import found 2 loans).
 *
 * Two status signals feed a card:
 *   • liveCount — real rows exist for the tenant (imported / entered) ⇒ Done.
 *   • detected  — an import surfaced the domain but nothing is committed yet ⇒
 *                 Detected · review (a persisted hint in `onboarding_state.sections`).
 * Anything else is the neutral Add-later (never a red nag).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LucideIcon } from 'lucide-react';
import type {
  OnboardingStatus,
  SectionStatusValue,
  SectionStateEntry,
} from '@/lib/onboarding/status';
import type { DomainKind } from '@/lib/onboarding/sections/registry';
import type { BoardCardStatus } from '@/components/onboarding/helpers';
import { deriveBoardCardStatus } from '@/components/onboarding/helpers';

/** The long-tail domains this module surfaces on the board. */
export const ONBOARDING_DOMAIN_KEYS = ['debt', 'leases', 'fixed_assets'] as const;
export type OnboardingDomainKey = (typeof ONBOARDING_DOMAIN_KEYS)[number];

/**
 * The (future) live-count field name on `OnboardingStatus.counts` for each domain.
 * `OnboardingStatus` does not expose these counts today; the readers below probe for
 * them defensively so the card flips to Done automatically the moment the lead widens
 * `OnboardingCounts` — with zero change here. Until then, Done derives from an explicit
 * hint written on create (see `setDomainDetectedHint`).
 */
export const DOMAIN_COUNT_KEY: Record<OnboardingDomainKey, string> = {
  debt: 'debts',
  leases: 'leases',
  fixed_assets: 'fixedAssets',
};

/** The resolved inputs a domain's status derives from. Pure data. */
export interface DomainDeriveInput {
  /** Number of committed rows (debts / leases / assets) for the tenant. */
  liveCount?: number;
  /** An import surfaced this domain but nothing is committed yet. */
  detected?: boolean;
  /** The user explicitly marked the domain not-applicable ("no debt"). */
  markedNotApplicable?: boolean;
  /** The user chose to add this later. */
  skipped?: boolean;
  /** The staged proposal (ai_decisions row) behind a `detected` hint, when known. */
  proposalId?: string | null;
}

/**
 * Board-card status (Done / Detected / Add-later) for a long-tail domain. Live rows
 * win; then a detected hint; else the neutral add-later. Pure and total.
 */
export function deriveDomainBoardStatus(input: DomainDeriveInput): BoardCardStatus {
  return deriveBoardCardStatus({
    done: (input.liveCount ?? 0) > 0,
    detected: !!input.detected,
  });
}

/**
 * Section-lifecycle status for a long-tail domain, matching the SectionDefinition
 * contract's `SectionStatusValue`. Live rows ⇒ done; an explicit n/a or skip is
 * honored; a detected-but-uncommitted import ⇒ in_progress; else not_started. Pure.
 */
export function deriveDomainSectionStatus(input: DomainDeriveInput): SectionStatusValue {
  if ((input.liveCount ?? 0) > 0) return 'done';
  if (input.markedNotApplicable) return 'n_a';
  if (input.skipped) return 'skipped';
  if (input.detected) return 'in_progress';
  return 'not_started';
}

/**
 * Resolve a domain's derive-inputs from a loaded `OnboardingStatus`. Reads (a) a live
 * count from `status.counts` if the lead has widened it, and (b) the persisted hint in
 * `status.sections[key]`. The hint encoding reuses the EXISTING `SectionStateEntry`
 * shape (no schema change): `status:'in_progress'` (+ optional `proposalId`) means
 * "detected · review", `status:'done'` means committed, `n_a`/`skipped` are explicit
 * dispositions. Pure and total; tolerant of a null status or an absent/legacy blob.
 *
 * NOTE FOR THE LEAD (read side): `loadOnboardingStatus` normalizes `sections` through
 * `normalizeSections`, which today DROPS any key not in `SECTION_KEYS`. So a hint
 * written under `debt`/`leases`/`fixed_assets` is preserved in the DB by
 * `setDomainDetectedHint` but will not survive the READ until those three keys are
 * added to `SECTION_KEYS` (status.ts). This function is written to light up the moment
 * that one-line widening lands — no change needed here.
 */
export function readDomainHint(
  status: OnboardingStatus | null,
  key: OnboardingDomainKey,
): DomainDeriveInput {
  if (!status) return {};

  const out: DomainDeriveInput = {};

  const counts = status.counts as unknown as Record<string, number | undefined> | undefined;
  const liveCount = counts?.[DOMAIN_COUNT_KEY[key]];
  if (typeof liveCount === 'number' && liveCount > 0) out.liveCount = liveCount;

  const map = status.sections as Record<string, SectionStateEntry | undefined> | undefined;
  const entry = map?.[key];
  if (entry) {
    if (entry.status === 'done') {
      out.liveCount = Math.max(out.liveCount ?? 0, 1);
    } else if (entry.status === 'n_a') {
      out.markedNotApplicable = true;
    } else if (entry.status === 'skipped') {
      out.skipped = true;
    } else if (entry.status === 'in_progress' || entry.proposalId) {
      out.detected = true;
      out.proposalId = entry.proposalId ?? null;
    }
  }

  return out;
}

/** Convenience: board status straight from a loaded status (hint-aware). Pure. */
export function domainBoardStatus(status: OnboardingStatus | null, key: OnboardingDomainKey): BoardCardStatus {
  return deriveDomainBoardStatus(readDomainHint(status, key));
}

/** Convenience: section status straight from a loaded status (hint-aware). Pure. */
export function domainSectionStatus(status: OnboardingStatus | null, key: OnboardingDomainKey): SectionStatusValue {
  return deriveDomainSectionStatus(readDomainHint(status, key));
}

/**
 * The self-describing metadata for a long-tail domain section — a superset of the
 * Wave-0 `SectionDefinition` contract (design spec §6) with a string `key`, since the
 * registry's `SectionKey`/`DomainKind` unions do not yet include these domains. The
 * lead registers these by (optionally) widening those unions; the board descriptor
 * (below, `SetupHomeDomain`-shaped) needs no widening and drops straight in.
 */
export interface DomainSectionMeta {
  key: OnboardingDomainKey;
  label: string;
  icon: LucideIcon;
  tone: 'required' | 'recommended' | 'optional';
  domainKind: DomainKind;
  /** Import paths this domain accepts, best → fallback. `manual` always works (degrade-safe). */
  importSources: ('document' | 'csv' | 'manual')[];
  skippable: boolean;
  /** True when the user may mark the domain not-applicable ("no debt"). */
  notApplicable: boolean;
  /** Deep-link to the domain's existing surface (where the full flow + manual entry live). */
  href: string;
  /** Key the client shell maps to this section's ReviewComponent (see app/(app)/onboarding/sections/*). */
  reviewComponentKey: string;
  /** Single source of truth for this section's status (live count wins; hint next; else not_started). */
  deriveStatus: (status: OnboardingStatus | null) => SectionStatusValue;
}

/**
 * Persist a "detected · review" hint for a long-tail domain so its board card lights
 * up after an import surfaced it (e.g. a QuickBooks conversion found 2 loans). This is
 * the SETTER the brief asks us to expose; the IMPORT SHELL that calls it is NOT edited
 * here (see report).
 *
 * It does a raw read-merge-write on `core.organizations.onboarding_state`, preserving
 * every other flag and section key (unlike a `normalizeSections`-based merge, which
 * would drop keys outside `SECTION_KEYS`). Uses the ADMIN client (the org row is
 * service-role-write for onboarding_state, mirroring `persistOnboardingProgress`).
 * Degrade-safe: never throws, returns `{ persisted: false }` on any error.
 *
 * @param opts.detected  default true; false clears the hint back to not_started.
 * @param opts.proposalId the staged ai_decisions row, when the importer has one.
 */
export async function setDomainDetectedHint(
  admin: SupabaseClient,
  orgId: string,
  key: OnboardingDomainKey,
  opts: { detected?: boolean; proposalId?: string | null } = {},
): Promise<{ persisted: boolean }> {
  try {
    const read = await admin
      .schema('core')
      .from('organizations')
      .select('onboarding_state')
      .eq('id', orgId)
      .maybeSingle();
    if (read.error || !read.data) return { persisted: false };

    const raw = (read.data as { onboarding_state?: unknown }).onboarding_state;
    const state: Record<string, unknown> =
      raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    const sections: Record<string, unknown> =
      state.sections && typeof state.sections === 'object'
        ? { ...(state.sections as Record<string, unknown>) }
        : {};

    const detected = opts.detected !== false;
    const now = new Date().toISOString();
    const prevEntry =
      sections[key] && typeof sections[key] === 'object'
        ? (sections[key] as Record<string, unknown>)
        : {};

    sections[key] = {
      ...prevEntry,
      status: detected ? 'in_progress' : 'not_started',
      updatedAt: now,
      ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
    };
    state.sections = sections;
    state.updatedAt = now;

    const upd = await admin
      .schema('core')
      .from('organizations')
      .update({ onboarding_state: state })
      .eq('id', orgId);

    return { persisted: !upd.error };
  } catch {
    return { persisted: false };
  }
}
