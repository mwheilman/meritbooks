/**
 * First-run onboarding STATUS — server-side detection + progress persistence.
 *
 * The unified inaugural wizard (`/onboarding`) needs to know two things:
 *   1. Is this tenant on its FIRST RUN? — i.e. has it never established its book
 *      of record. The canonical signal (per the task brief) is "no go-live /
 *      opening entry (or an explicit flag)". A tenant with ANY posted GL activity
 *      is, by definition, already live and is NOT first-run — this is what keeps
 *      an established tenant (seeded, imported, or long-running) from ever being
 *      bounced back into the wizard.
 *   2. Where did they leave off, so the wizard can resume.
 *
 * PERSISTENCE IS DEGRADE-SAFE. A durable "current step / complete" flag ideally
 * lives in a dedicated column — see the REPORTED migration below. Until that
 * column exists this module still works:
 *   - It ALWAYS persists completion on the always-present `setup_complete` column,
 *     so "finished onboarding" survives even without the new column.
 *   - It attempts to read/write `core.organizations.onboarding_state` (jsonb) for
 *     the richer step memory, and silently degrades (statePersisted=false) when the
 *     column is absent — the wizard still runs, it just can't remember the exact
 *     step across reloads (it re-derives a sensible step from live counts instead).
 *
 * ── REPORTED MIGRATION (for the lead — this module is written to light up the
 *    moment it lands, no code change needed) ──────────────────────────────────
 *      alter table core.organizations
 *        add column if not exists onboarding_state jsonb not null default '{}'::jsonb;
 *    Shape written by this module:
 *      { "currentStep": "opening", "complete": false, "updatedAt": "<iso>" }
 *    (An `onboarding_progress` side-table would also work; a single jsonb column on
 *    the org is the lightest option and inherits the org row's RLS.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The ordered steps of the unified onboarding wizard. */
export type OnboardingStepKey = 'welcome' | 'coa' | 'opening' | 'bank' | 'erp' | 'team' | 'launch';

export const ONBOARDING_STEPS: OnboardingStepKey[] = [
  'welcome',
  'coa',
  'opening',
  'bank',
  'erp',
  'team',
  'launch',
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-section status map (Wave-0 foundation for the SectionDefinition framework).
//
// The onboarding shell is being generalized so every setup DOMAIN (company, chart
// of accounts, opening balances, bank, integrations, team, and — in later waves —
// AR/AP, debt, leases, jobs/WIP, …) is a self-describing section. Each section has
// a lifecycle status persisted here, alongside the flow's currentStep/complete
// flags, inside the SAME `core.organizations.onboarding_state` jsonb column (no new
// migration — the column already exists). This only WIDENS the shape the normalizer
// reads/writes; it stays degrade-safe exactly like the flow flags do.
//
// IMPORTANT: the persisted section status is a HINT, not the truth. `deriveStatus`
// in the section registry always lets a live-count-derived `done` win over stale
// stored state — so a section that is actually satisfied (e.g. a company exists)
// reads `done` even if the map was never written.
// ─────────────────────────────────────────────────────────────────────────────

/** The domain sections the shell renders (the flow's `launch` step is terminal, not a domain). */
export const SECTION_KEYS = ['welcome', 'coa', 'opening', 'bank', 'erp', 'team'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** The lifecycle status of a single section. */
export const SECTION_STATUS_VALUES = ['not_started', 'in_progress', 'done', 'skipped', 'n_a'] as const;
export type SectionStatusValue = (typeof SECTION_STATUS_VALUES)[number];

/** One entry in the persisted per-section status map. */
export interface SectionStateEntry {
  status: SectionStatusValue;
  /** ISO timestamp of the last transition. */
  updatedAt: string;
  /** Clerk user id that made the transition, when known. */
  updatedBy?: string;
  /** The staged proposal (ai_decisions row) this status refers to, when relevant. */
  proposalId?: string;
}

/** The persisted per-section status map, keyed by section key. */
export type SectionStatusMap = Partial<Record<SectionKey, SectionStateEntry>>;

/** Live tenant counts that drive first-run detection and step derivation. */
export interface OnboardingCounts {
  entities: number;
  accounts: number;
  teamMembers: number;
  glEntries: number;
  /** Active bank accounts linked (Plaid or manual) — the "bank connected" signal. */
  bankAccounts: number;
  /** Bank-feed transactions that have been categorized/approved — "first transaction categorized". */
  categorizedTransactions: number;
}

/** The (best-effort) durable progress flag stored on the org. */
export interface OnboardingStateFlag {
  currentStep?: OnboardingStepKey;
  complete?: boolean;
  updatedAt?: string;
  /** Per-section lifecycle status (Wave-0 widening; absent on legacy rows). */
  sections?: SectionStatusMap;
}

export interface OnboardingStatus {
  /** True when the tenant has never gone live (no GL activity) and is not flagged complete. */
  firstRun: boolean;
  /** True once onboarding is finished (explicit flag) OR the tenant has posted GL activity. */
  complete: boolean;
  /** The step the wizard should open on (saved flag wins; else derived from counts). */
  currentStep: OnboardingStepKey;
  counts: OnboardingCounts;
  /** True when at least one balanced OPENING_BALANCE entry has been posted (go-live). */
  hasOpeningEntry: boolean;
  /** The always-present org provisioning flag. */
  setupComplete: boolean;
  /** True when the richer onboarding_state column is available (see migration note). */
  statePersisted: boolean;
  /** The stored flag, when the column exists. */
  flag: OnboardingStateFlag | null;
  /** The persisted per-section status map (empty when unset/absent). Derived `done`
   *  from live counts still wins over any stale value here — see the registry. */
  sections: SectionStatusMap;
}

/** Read the org-level onboarding flags, degrading when the jsonb column is absent. */
async function readOrgOnboarding(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ setupComplete: boolean; flag: OnboardingStateFlag | null; statePersisted: boolean }> {
  // Try the rich read first (setup_complete + onboarding_state).
  const rich = await admin
    .schema('core')
    .from('organizations')
    .select('setup_complete, onboarding_state')
    .eq('id', orgId)
    .maybeSingle();

  if (!rich.error && rich.data) {
    const row = rich.data as { setup_complete: boolean | null; onboarding_state: unknown };
    const flag = normalizeFlag(row.onboarding_state);
    return { setupComplete: row.setup_complete === true, flag, statePersisted: true };
  }

  // Column absent (or select failed) → degrade to the always-present column only.
  const basic = await admin
    .schema('core')
    .from('organizations')
    .select('setup_complete')
    .eq('id', orgId)
    .maybeSingle();

  const setupComplete = !basic.error && basic.data
    ? (basic.data as { setup_complete: boolean | null }).setup_complete === true
    : false;

  return { setupComplete, flag: null, statePersisted: false };
}

/** Coerce an unknown jsonb value into a typed flag (defensive — never throws). */
function normalizeFlag(raw: unknown): OnboardingStateFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const step = obj.currentStep;
  const flag: OnboardingStateFlag = {};
  if (typeof step === 'string' && (ONBOARDING_STEPS as string[]).includes(step)) {
    flag.currentStep = step as OnboardingStepKey;
  }
  if (typeof obj.complete === 'boolean') flag.complete = obj.complete;
  if (typeof obj.updatedAt === 'string') flag.updatedAt = obj.updatedAt;
  const sections = normalizeSections(obj.sections);
  if (sections) flag.sections = sections;
  return flag;
}

/**
 * Coerce an unknown jsonb value into a typed per-section status map. Unknown section
 * keys and unknown status values are dropped rather than trusted, so a malformed or
 * future-shaped blob can never corrupt the map or throw. Returns undefined when there
 * is nothing valid to keep.
 */
export function normalizeSections(raw: unknown): SectionStatusMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: SectionStatusMap = {};
  for (const key of SECTION_KEYS) {
    const entry = src[key];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.status !== 'string' || !(SECTION_STATUS_VALUES as readonly string[]).includes(e.status)) continue;
    const normalized: SectionStateEntry = {
      status: e.status as SectionStatusValue,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
    };
    if (typeof e.updatedBy === 'string') normalized.updatedBy = e.updatedBy;
    if (typeof e.proposalId === 'string') normalized.proposalId = e.proposalId;
    out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A best-effort head-count that returns 0 on any error (status must never throw). */
async function safeCount(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  try {
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Assemble the full onboarding status for a tenant.
 *
 * `supabase` is the RLS-scoped request client (counts are org-isolated by RLS);
 * `admin` reads the org flags (org row is service-role-write only for onboarding_state).
 */
export async function loadOnboardingStatus(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  orgId: string,
): Promise<OnboardingStatus> {
  const [entities, accounts, teamMembers, glEntries, openingCount, bankAccounts, categorizedTransactions] = await Promise.all([
    safeCount(
      supabase.schema('core').from('locations').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ),
    safeCount(supabase.from('accounts').select('id', { count: 'exact', head: true })),
    safeCount(supabase.schema('core').from('employees').select('id', { count: 'exact', head: true })),
    safeCount(supabase.from('gl_entries').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('gl_entries').select('id', { count: 'exact', head: true }).eq('source_module', 'OPENING_BALANCE'),
    ),
    safeCount(
      supabase.from('bank_accounts').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ),
    // A transaction the customer (or AI, once approved) has categorized: status has
    // advanced past PENDING (CATEGORIZED/APPROVED/POSTED are all "handled").
    safeCount(
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).neq('status', 'PENDING'),
    ),
  ]);

  const counts: OnboardingCounts = { entities, accounts, teamMembers, glEntries, bankAccounts, categorizedTransactions };
  const hasOpeningEntry = openingCount > 0;

  const { setupComplete, flag, statePersisted } = await readOrgOnboarding(admin, orgId);

  // Complete when explicitly flagged, OR when the tenant already has GL activity
  // (an established book of record is not "first run" regardless of the flag).
  const complete = flag?.complete === true || glEntries > 0;
  const firstRun = !complete;

  const currentStep = flag?.currentStep ?? deriveStep(counts, hasOpeningEntry);
  const sections = flag?.sections ?? {};

  return { firstRun, complete, currentStep, counts, hasOpeningEntry, setupComplete, statePersisted, flag, sections };
}

/** Derive a sensible resume step from live tenant state (used when no flag is stored). */
export function deriveStep(counts: OnboardingCounts, hasOpeningEntry: boolean): OnboardingStepKey {
  if (counts.entities === 0) return 'welcome';
  if (counts.accounts === 0) return 'coa';
  if (!hasOpeningEntry) return 'opening';
  return 'launch';
}

/** A patch applied to the persisted onboarding state. */
export interface OnboardingProgressPatch {
  currentStep?: OnboardingStepKey;
  complete?: boolean;
  /** Per-section status transitions, MERGED (by key) into the existing map. */
  sections?: SectionStatusMap;
}

/**
 * Merge a progress patch into the existing onboarding state flag. Pure and total,
 * so the read-merge-write below is unit-testable without a DB. Section entries are
 * merged BY KEY (a patch for one section never drops the others); the flow flags
 * (currentStep/complete) are overwritten only when present in the patch, so writing
 * a section status can never clobber the resume step and vice-versa.
 */
export function mergeOnboardingState(
  prev: OnboardingStateFlag | null,
  patch: OnboardingProgressPatch,
  now: string = new Date().toISOString(),
): OnboardingStateFlag {
  const base = prev ?? {};
  const merged: OnboardingStateFlag = {
    ...base,
    ...(patch.currentStep ? { currentStep: patch.currentStep } : {}),
    ...(patch.complete !== undefined ? { complete: patch.complete } : {}),
    updatedAt: now,
  };
  if (patch.sections) {
    merged.sections = { ...(base.sections ?? {}), ...patch.sections };
  }
  return merged;
}

/**
 * Persist onboarding progress. ALWAYS writes the durable `setup_complete` flag on
 * completion; ADDITIONALLY read-merge-writes the rich `onboarding_state` jsonb when
 * that column exists (so the flow flags and the per-section status map coexist and a
 * single-field patch never clobbers the rest). Returns whether the rich column
 * persisted. Degrade-safe: an absent column simply yields statePersisted=false.
 */
export async function persistOnboardingProgress(
  admin: SupabaseClient,
  orgId: string,
  patch: OnboardingProgressPatch,
): Promise<{ statePersisted: boolean }> {
  // On completion, always flip the always-present provisioning flag (durable).
  if (patch.complete === true) {
    await admin
      .schema('core')
      .from('organizations')
      .update({ setup_complete: true })
      .eq('id', orgId);
  }

  // Read the existing state (degrade-safe) so we merge rather than overwrite.
  const { flag } = await readOrgOnboarding(admin, orgId);
  const merged = mergeOnboardingState(flag, patch);

  const { error } = await admin
    .schema('core')
    .from('organizations')
    .update({ onboarding_state: merged })
    .eq('id', orgId);

  return { statePersisted: !error };
}
