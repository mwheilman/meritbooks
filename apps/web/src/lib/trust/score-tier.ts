import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The confidence-tier engine. Turns a confidence score (+ amount, trust) into a
 * disposition: auto (the machine may act), review (a human should look), or
 * escalate (a human must). This is what makes the documented-but-unenforced
 * thresholds real — every autonomous action runs through here to decide whether
 * it posts itself or lands in the exception queue.
 */
export type Tier = 'auto' | 'review' | 'escalate';

export interface TierPolicy {
  /** confidence ≥ this ⇒ eligible for auto */
  autoThreshold: number;
  /** confidence ≥ this ⇒ review; below ⇒ escalate */
  reviewThreshold: number;
  /** amount cap for auto (cents); null = no cap */
  autoMaxCents: number | null;
}

export interface TierInput {
  confidence: number; // 0..1
  amountCents?: number;
  /** if explicitly false, auto is blocked regardless of confidence */
  trustedVendor?: boolean;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Pure decision — no I/O, unit-tested. Given a confidence (and optionally amount
 * and vendor trust), return the tier + a human-readable reason for the audit log
 * and the exception queue.
 */
export function scoreToTier(input: TierInput, policy: TierPolicy): { tier: Tier; reason: string } {
  const c = input.confidence;

  if (!(c >= policy.reviewThreshold)) {
    return {
      tier: 'escalate',
      reason: `Confidence ${pct(c)} is below the review threshold ${pct(policy.reviewThreshold)} — needs a human.`,
    };
  }

  const overCap =
    policy.autoMaxCents != null && input.amountCents != null && input.amountCents > policy.autoMaxCents;
  const untrusted = input.trustedVendor === false;

  if (c >= policy.autoThreshold && !overCap && !untrusted) {
    return {
      tier: 'auto',
      reason: `Confidence ${pct(c)} ≥ auto threshold ${pct(policy.autoThreshold)}; within limits — auto-applied.`,
    };
  }

  const why =
    c < policy.autoThreshold
      ? `confidence ${pct(c)} below auto threshold ${pct(policy.autoThreshold)}`
      : overCap
        ? 'amount exceeds the auto-approve cap'
        : 'vendor is not trusted';
  return { tier: 'review', reason: `Queued for review — ${why}.` };
}

const toNum = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Load the effective tier policy for an org. Reads the real, configured settings
 * (org.ai_auto_approve_threshold / ai_auto_approve_max_cents). reviewThreshold
 * defaults to 0.70 (the documented cut-line) until per-location overrides are
 * wired. Never throws — falls back to safe defaults.
 */
export async function getTierPolicy(
  supabase: SupabaseClient,
  orgId: string,
): Promise<TierPolicy> {
  try {
    const { data } = await supabase
      .schema('core').from('organizations')
      .select('ai_auto_approve_threshold, ai_auto_approve_max_cents')
      .eq('id', orgId)
      .single();
    return {
      autoThreshold: toNum(data?.ai_auto_approve_threshold, 0.85),
      reviewThreshold: 0.7,
      autoMaxCents: (data?.ai_auto_approve_max_cents as number | null) ?? 1_000_000,
    };
  } catch {
    return { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }
}
