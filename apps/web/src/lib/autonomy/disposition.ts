/**
 * The Autonomy Disposition helper (M10) — the single decision the whole product
 * routes an AI action through to answer one question: "may the machine act on this,
 * or must a human?"  It sits DOWNSTREAM of the trust spine (lib/trust/score-tier's
 * `scoreToTier`, which turns confidence+amount into an `auto|review|escalate` tier)
 * and layers the tenant's GOVERNANCE on top:
 *
 *   kill switch  →  per-feature dial (OFF / PROPOSE / AUTO_UNDER_LIMIT)  →  disposition
 *
 * Canon §3: auto-post is OFF by default; autonomy is a per-tenant, per-task dial;
 * SoD applies to the AI itself. So this NEVER returns AUTO unless a tenant admin has
 * explicitly opted the feature up to AUTO_UNDER_LIMIT and the action clears both the
 * confidence tier AND the materiality cap.
 *
 * The decision function `decideDisposition` is PURE (no I/O) and exhaustively unit
 * tested. `resolveDisposition` does the RLS-scoped reads and DEGRADES SAFE: if the
 * kill-switch/settings rows (or even the tables, pre-migration-075) are missing, it
 * falls back to the most-conservative behavior (PROPOSE → human review) rather than
 * throwing or ever auto-applying.
 *
 * NOTE: this wave ships the helper + tests only. Retrofitting detectors/proposers to
 * call it is a separate, owned workstream — this file introduces no behavior change
 * to existing callers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Tier } from '@/lib/trust/score-tier';

/** The tenant's dial for a single feature. */
export type AutonomyMode = 'OFF' | 'PROPOSE' | 'AUTO_UNDER_LIMIT';

/**
 * The four possible outcomes:
 *  - AUTO     the machine may apply the action itself.
 *  - REVIEW   a human should look (routine approval queue).
 *  - ESCALATE a human MUST look (urgent — high risk / money already at stake).
 *  - BLOCKED  nothing happens: the feature is OFF, or the global kill switch is engaged.
 */
export type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';

/** A resolved per-feature setting (null = no row ⇒ conservative default). */
export interface AutonomySetting {
  mode: AutonomyMode;
  materialityLimitCents: number | null;
}

export interface DispositionDecision {
  disposition: Disposition;
  reason: string;
}

export interface DecideInput {
  /** true ⇒ the tenant's global kill switch is engaged. */
  killSwitchEngaged: boolean;
  /** the feature's dial, or null when no row exists (⇒ default PROPOSE). */
  setting: AutonomySetting | null;
  /** the confidence/amount tier from scoreToTier. */
  scoreTier: Tier;
  /** the $-amount the action would move/affect, if known (cents). */
  amountCents?: number | null;
}

/** When no per-feature row exists we treat the feature as being in this dial. */
export const DEFAULT_MODE: AutonomyMode = 'PROPOSE';

/**
 * PURE disposition decision. No I/O; exhaustively unit tested.
 *
 * Precedence (most-restrictive first):
 *   1. kill switch engaged           → BLOCKED
 *   2. mode OFF                       → BLOCKED (capability disabled for the tenant)
 *   3. mode PROPOSE                   → never AUTO. auto/review tiers → REVIEW;
 *                                       an escalate tier is preserved → ESCALATE
 *                                       (safer than flattening urgency; still never auto).
 *   4. mode AUTO_UNDER_LIMIT         → AUTO only when scoreTier==='auto' AND a
 *                                       materiality cap is configured AND a known
 *                                       amount is at/under it. Otherwise map the tier:
 *                                       auto(over/unknown cap)/review → REVIEW, escalate → ESCALATE.
 */
export function decideDisposition(input: DecideInput): DispositionDecision {
  if (input.killSwitchEngaged) {
    return {
      disposition: 'BLOCKED',
      reason: 'Global autonomy kill switch is engaged — no AI action auto-applies for this organization.',
    };
  }

  const mode: AutonomyMode = input.setting?.mode ?? DEFAULT_MODE;

  if (mode === 'OFF') {
    return {
      disposition: 'BLOCKED',
      reason: 'This AI capability is turned OFF for your organization.',
    };
  }

  if (mode === 'PROPOSE') {
    if (input.scoreTier === 'escalate') {
      return {
        disposition: 'ESCALATE',
        reason: 'Propose-only mode: this action needs a human — escalated (low confidence / high risk).',
      };
    }
    return {
      disposition: 'REVIEW',
      reason: 'Propose-only mode: the AI drafts, a human reviews and approves. Nothing auto-applies.',
    };
  }

  // mode === 'AUTO_UNDER_LIMIT'
  if (input.scoreTier === 'auto') {
    const limit = input.setting?.materialityLimitCents ?? null;
    const amount = input.amountCents;
    if (limit == null) {
      return {
        disposition: 'REVIEW',
        reason: 'Auto-under-limit is enabled but no materiality cap is configured — routed to review until a cap is set.',
      };
    }
    if (amount == null) {
      return {
        disposition: 'REVIEW',
        reason: 'Auto-under-limit is enabled but the action’s amount is unknown — routed to review (cannot confirm it is under the cap).',
      };
    }
    if (amount <= limit) {
      return {
        disposition: 'AUTO',
        reason: `High confidence and within the materiality cap — auto-applied (amount ≤ cap).`,
      };
    }
    return {
      disposition: 'REVIEW',
      reason: 'High confidence but the amount exceeds the materiality cap — routed to review.',
    };
  }

  if (input.scoreTier === 'escalate') {
    return {
      disposition: 'ESCALATE',
      reason: 'Below the review threshold — escalated to a human.',
    };
  }

  return {
    disposition: 'REVIEW',
    reason: 'Confidence below the auto threshold — routed to review.',
  };
}

interface KillSwitchRow {
  engaged: boolean | null;
}
interface SettingRow {
  mode: string | null;
  materiality_limit_cents: number | string | null;
}

function normalizeMode(raw: string | null | undefined): AutonomyMode {
  if (raw === 'OFF' || raw === 'PROPOSE' || raw === 'AUTO_UNDER_LIMIT') return raw;
  return DEFAULT_MODE; // unknown/garbage ⇒ conservative
}

export interface ResolveParams {
  orgId: string;
  feature: string;
  scoreTier: Tier;
  amountCents?: number | null;
  supabase: SupabaseClient;
}

/**
 * Read the live kill-switch + per-feature dial for an org and resolve a disposition.
 * DEGRADES SAFE: any read error (including the tables not existing before migration
 * 075 is applied) resolves as "no kill switch, no row" ⇒ the conservative PROPOSE
 * path, so this can be adopted before the migration lands without breaking anything
 * and can never auto-apply on a missing/degraded read.
 *
 * Returns the bare Disposition (per the M10 contract). Use `resolveDispositionDetailed`
 * when the caller also wants the human-readable reason + resolved mode for its log.
 */
export async function resolveDisposition(params: ResolveParams): Promise<Disposition> {
  const detailed = await resolveDispositionDetailed(params);
  return detailed.disposition;
}

export interface DetailedDispositionResult extends DispositionDecision {
  mode: AutonomyMode;
  killSwitchEngaged: boolean;
  materialityLimitCents: number | null;
}

/**
 * Same as `resolveDisposition` but returns the full context (disposition + reason +
 * resolved mode + kill-switch state + cap) so a caller can write a rich audit row.
 */
export async function resolveDispositionDetailed(
  params: ResolveParams,
): Promise<DetailedDispositionResult> {
  const { orgId, feature, scoreTier, amountCents, supabase } = params;

  let killSwitchEngaged = false;
  let setting: AutonomySetting | null = null;

  // Kill switch — absent row OR missing table ⇒ NOT engaged (opt-in e-stop).
  try {
    const { data } = await supabase
      .from('autonomy_kill_switch')
      .select('engaged')
      .eq('org_id', orgId)
      .maybeSingle();
    killSwitchEngaged = ((data as KillSwitchRow | null)?.engaged ?? false) === true;
  } catch {
    killSwitchEngaged = false;
  }

  // Per-feature dial — absent row OR missing table ⇒ null ⇒ default PROPOSE.
  try {
    const { data } = await supabase
      .from('autonomy_settings')
      .select('mode, materiality_limit_cents')
      .eq('org_id', orgId)
      .eq('feature', feature)
      .maybeSingle();
    const row = data as SettingRow | null;
    if (row) {
      const cap = row.materiality_limit_cents;
      setting = {
        mode: normalizeMode(row.mode),
        materialityLimitCents: cap == null ? null : Number(cap),
      };
    }
  } catch {
    setting = null;
  }

  const decision = decideDisposition({ killSwitchEngaged, setting, scoreTier, amountCents });
  return {
    ...decision,
    mode: setting?.mode ?? DEFAULT_MODE,
    killSwitchEngaged,
    materialityLimitCents: setting?.materialityLimitCents ?? null,
  };
}
