/**
 * H6_JE_SELF_POST at the manual journal-entry post routes (05 §4.1 H6, Q4 · wave 2G).
 *
 * A manual JE at or above the tenant's self-post amount
 * (core.organizations.je_self_post_threshold_cents, default $25,000) must be posted by
 * someone other than the person who prepared it. The manual post routes create AND post
 * in one request, so the preparer IS the poster by construction.
 *
 * ENFORCEMENT FOLLOWS THE TENANT'S ACCESS MODE (05 R-11):
 *   v2 (or the mode can't be read) → refused (409, plain-English message);
 *   dual   → allowed, and the would-be refusal is written to core.access_dualrun_log as
 *            an UNEXPLAINED disagreement, so the tenant must acknowledge it before the
 *            flip to v2 (posting a draft someone else prepared is not built yet, so in v2
 *            these entries cannot be posted by one person at all);
 *   legacy → allowed (the comparison is off).
 *
 * Route posts are always treated as manual: a caller-supplied `source_module` never
 * earns the system-generated exemption.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_DEPS, type EnforcementMode } from '@/lib/rbac/authorize';
import { ACTION_SOD_MESSAGE, checkActionSod } from '@/lib/rbac/sod';
import { loadTenantSodSettings } from '@/lib/rbac/sod-store';

export type JePostSodResult =
  | { ok: true; wouldDeny: boolean }
  | { ok: false; status: 409 | 503; error: string; code: 'SOD_SELF_POST' | 'SOD_UNVERIFIABLE' };

export interface JePostSodInput {
  orgId: string;
  /** Clerk id of the person creating + posting the entry. */
  actor: string;
  /**
   * Who prepared the entry, when that is not the actor (e.g. the member who proposed a
   * month-end WIP run that someone now approves). Defaults to `actor` (create + post in one
   * request). null = system-prepared with no human preparer → no self-post conflict.
   */
  preparedBy?: string | null;
  /** Entry size: total debits (bigint cents as number). */
  amountCents: number;
  /** Static route label for the dual-run log. */
  route: string;
  locationId?: string | null;
}

export interface JePostSodDeps {
  mode(orgId: string): Promise<EnforcementMode | null>;
  thresholdCents(orgId: string): Promise<number>;
  logWouldDeny(input: JePostSodInput, thresholdCents: number): Promise<void>;
}

function defaultDeps(admin: SupabaseClient): JePostSodDeps {
  return {
    mode: (orgId) => DEFAULT_DEPS.mode(orgId),
    thresholdCents: async (orgId) => (await loadTenantSodSettings(admin, orgId)).jeSelfPostThresholdCents,
    logWouldDeny: async (input, threshold) => {
      await DEFAULT_DEPS.log({
        orgId: input.orgId,
        membershipId: null,
        clerkUserId: input.actor,
        capability: 'gl.journal_entries',
        action: 'post',
        locationId: input.locationId ?? null,
        legacyDecision: true,
        v2Decision: false,
        route: input.route,
        kind: 'disagree',
        explained: false,
        reason: 'sod:PREPARER_CANNOT_POST',
        detail: { rule: 'H6_JE_SELF_POST', amount_cents: input.amountCents, threshold_cents: threshold },
      });
    },
  };
}

export async function checkManualJePostSod(
  admin: SupabaseClient,
  input: JePostSodInput,
  deps: Partial<JePostSodDeps> = {},
): Promise<JePostSodResult> {
  const d: JePostSodDeps = { ...defaultDeps(admin), ...deps };
  let mode: EnforcementMode | null;
  try {
    mode = await d.mode(input.orgId);
  } catch {
    mode = null;
  }
  let threshold: number;
  try {
    threshold = await d.thresholdCents(input.orgId);
  } catch {
    if (mode === 'legacy' || mode === 'dual') return { ok: true, wouldDeny: false };
    return { ok: false, status: 503, code: 'SOD_UNVERIFIABLE', error: 'The journal-entry posting rules could not be checked. Try again in a moment.' };
  }

  const code = checkActionSod({
    actor: input.actor,
    action: 'post',
    preparedBy: input.preparedBy === undefined ? input.actor : input.preparedBy,
    amountCents: input.amountCents,
    jeSelfPostThresholdCents: threshold,
  });
  if (!code) return { ok: true, wouldDeny: false };

  if (mode === 'legacy') return { ok: true, wouldDeny: true };
  if (mode === 'dual') {
    await d.logWouldDeny(input, threshold).catch(() => undefined);
    return { ok: true, wouldDeny: true };
  }
  return {
    ok: false,
    status: 409,
    code: 'SOD_SELF_POST',
    error: `${ACTION_SOD_MESSAGE[code]} Save it as a draft for a colleague to review — posting another person's draft is not available yet.`,
  };
}
