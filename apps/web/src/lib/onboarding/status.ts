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
export type OnboardingStepKey = 'welcome' | 'coa' | 'opening' | 'bank' | 'team' | 'launch';

export const ONBOARDING_STEPS: OnboardingStepKey[] = [
  'welcome',
  'coa',
  'opening',
  'bank',
  'team',
  'launch',
];

/** Live tenant counts that drive first-run detection and step derivation. */
export interface OnboardingCounts {
  entities: number;
  accounts: number;
  teamMembers: number;
  glEntries: number;
}

/** The (best-effort) durable progress flag stored on the org. */
export interface OnboardingStateFlag {
  currentStep?: OnboardingStepKey;
  complete?: boolean;
  updatedAt?: string;
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
  return flag;
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
  const [entities, accounts, teamMembers, glEntries, openingCount] = await Promise.all([
    safeCount(
      supabase.schema('core').from('locations').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ),
    safeCount(supabase.from('accounts').select('id', { count: 'exact', head: true })),
    safeCount(supabase.schema('core').from('employees').select('id', { count: 'exact', head: true })),
    safeCount(supabase.from('gl_entries').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('gl_entries').select('id', { count: 'exact', head: true }).eq('source_module', 'OPENING_BALANCE'),
    ),
  ]);

  const counts: OnboardingCounts = { entities, accounts, teamMembers, glEntries };
  const hasOpeningEntry = openingCount > 0;

  const { setupComplete, flag, statePersisted } = await readOrgOnboarding(admin, orgId);

  // Complete when explicitly flagged, OR when the tenant already has GL activity
  // (an established book of record is not "first run" regardless of the flag).
  const complete = flag?.complete === true || glEntries > 0;
  const firstRun = !complete;

  const currentStep = flag?.currentStep ?? deriveStep(counts, hasOpeningEntry);

  return { firstRun, complete, currentStep, counts, hasOpeningEntry, setupComplete, statePersisted, flag };
}

/** Derive a sensible resume step from live tenant state (used when no flag is stored). */
export function deriveStep(counts: OnboardingCounts, hasOpeningEntry: boolean): OnboardingStepKey {
  if (counts.entities === 0) return 'welcome';
  if (counts.accounts === 0) return 'coa';
  if (!hasOpeningEntry) return 'opening';
  return 'launch';
}

/**
 * Persist onboarding progress. ALWAYS writes the durable `setup_complete` flag on
 * completion; ADDITIONALLY writes the rich `onboarding_state` jsonb when that
 * column exists. Returns whether the rich column persisted.
 */
export async function persistOnboardingProgress(
  admin: SupabaseClient,
  orgId: string,
  patch: { currentStep?: OnboardingStepKey; complete?: boolean },
): Promise<{ statePersisted: boolean }> {
  // On completion, always flip the always-present provisioning flag (durable).
  if (patch.complete === true) {
    await admin
      .schema('core')
      .from('organizations')
      .update({ setup_complete: true })
      .eq('id', orgId);
  }

  // Attempt the rich jsonb write; degrade silently if the column is absent.
  const state: OnboardingStateFlag = {
    ...(patch.currentStep ? { currentStep: patch.currentStep } : {}),
    ...(patch.complete !== undefined ? { complete: patch.complete } : {}),
    updatedAt: new Date().toISOString(),
  };

  const { error } = await admin
    .schema('core')
    .from('organizations')
    .update({ onboarding_state: state })
    .eq('id', orgId);

  return { statePersisted: !error };
}
