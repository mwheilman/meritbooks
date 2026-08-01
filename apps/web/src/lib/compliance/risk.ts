/**
 * Vendor-compliance risk engine (pure).
 *
 * Turns a vendor's compliance-document state + open A/P exposure into an AI risk
 * assessment: a severity score, a priority label, and — crucially — a *handling
 * confidence* that we feed through the trust layer's `scoreToTier`. That is what
 * decides whether the machine may quietly schedule the routine chase (`auto`), a
 * human should glance (`review`), or a human MUST act (`escalate`). Escalations
 * are the items that get shaped into the /exceptions queue.
 *
 * No I/O — unit-reviewable. All thresholds come from the org's TierPolicy so the
 * documented auto/review cut-lines are the real ones.
 */

import { scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';

export type DocState = 'valid' | 'expiring' | 'expired' | 'missing' | 'pending';
export type RiskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface RiskDoc {
  doc_type: string;
  state: DocState;
}

export interface RiskInput {
  docs: RiskDoc[];
  /** vendor is not compliant AND has no active override (payment is blocked) */
  onHold: boolean;
  hasActiveOverride: boolean;
  /** approved/unpaid A/P behind the hold, in cents */
  openBillsCents: number;
}

export interface RiskAssessment {
  /** 0..1 severity — drives the priority label + sort order */
  score: number;
  /** 0..1 confidence the machine can auto-handle this — fed to scoreToTier */
  confidence: number;
  tier: Tier;
  priority: RiskPriority;
  /** worst document state on the vendor (what makes it risky) */
  worstState: DocState | 'none';
  /** human-readable compliance reason (audit trail + exception subtitle) */
  reason: string;
  /** the autonomy reason returned by scoreToTier */
  tierReason: string;
  /** should a chase reminder be teed up for this vendor's docs */
  chaseRecommended: boolean;
}

// Severity weight per document state. Worst-doc wins.
const STATE_WEIGHT: Record<DocState, number> = {
  expired: 0.95,
  missing: 0.9,
  expiring: 0.45,
  pending: 0.2,
  valid: 0,
};

// Base handling-confidence per worst state. High confidence ⇒ the machine can
// handle it alone (auto); low confidence ⇒ a human is needed (escalate). These
// are chosen so expired/missing land in `escalate`, `expiring` in `review`, and
// clean/valid vendors in `auto` under the default policy (auto 0.85 / review 0.70).
const HANDLING_CONF: Record<DocState | 'none', number> = {
  none: 0.99,
  valid: 0.98,
  pending: 0.9,
  expiring: 0.75,
  expired: 0.5,
  missing: 0.45,
};

const STATE_ORDER: DocState[] = ['expired', 'missing', 'expiring', 'pending', 'valid'];

const DOC_SHORT: Record<string, string> = {
  W9: 'W-9',
  GL_COI: 'GL COI',
  WC_COI: 'WC COI',
  WC_EXEMPTION: 'WC exemption',
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function worstDocState(docs: RiskDoc[]): { state: DocState | 'none'; doc: RiskDoc | null } {
  let best: DocState | 'none' = 'none';
  let bestDoc: RiskDoc | null = null;
  let bestWeight = -1;
  for (const d of docs) {
    const w = STATE_WEIGHT[d.state] ?? 0;
    if (w > bestWeight) {
      bestWeight = w;
      best = d.state;
      bestDoc = d;
    }
  }
  return { state: best, doc: bestDoc };
}

function priorityFromScore(score: number, hasActiveOverride: boolean): RiskPriority {
  // An active override lifts the payment block, so the urgency is capped — the
  // docs still need curing, but nothing is stuck behind them right now.
  const cap: RiskPriority = hasActiveOverride ? 'medium' : 'critical';
  let p: RiskPriority;
  if (score >= 0.85) p = 'critical';
  else if (score >= 0.6) p = 'high';
  else if (score >= 0.35) p = 'medium';
  else p = 'low';
  const rank: RiskPriority[] = ['low', 'medium', 'high', 'critical'];
  return rank.indexOf(p) > rank.indexOf(cap) ? cap : p;
}

const money = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Assess a single vendor's compliance risk and route it through the trust tier
 * engine. Pure: same inputs ⇒ same assessment.
 */
export function assessVendorRisk(input: RiskInput, policy: TierPolicy): RiskAssessment {
  const { docs, onHold, hasActiveOverride, openBillsCents } = input;
  const { state: worst, doc } = worstDocState(docs);

  // Severity: worst-doc weight, nudged up by real exposure behind an active hold.
  let score = STATE_WEIGHT[worst as DocState] ?? 0;
  if (onHold && openBillsCents > 0) {
    score = clamp01(score + Math.min(0.1, openBillsCents / 5_000_000)); // +0.1 near $50k exposure
  }
  if (hasActiveOverride) score = clamp01(score * 0.5); // override relieves immediate pressure

  // Handling confidence: how safely the machine can act without a human.
  let confidence = HANDLING_CONF[worst];
  if (hasActiveOverride) confidence = clamp01(confidence + 0.3); // someone already decided
  confidence = clamp01(confidence);

  // Route through the trust layer. Exposure is passed as the amount so a big
  // open balance can knock an otherwise-auto vendor down into review.
  const { tier, reason: tierReason } = scoreToTier(
    { confidence, amountCents: onHold ? openBillsCents : 0 },
    policy,
  );

  const priority = priorityFromScore(score, hasActiveOverride);
  const chaseRecommended = worst === 'expired' || worst === 'missing' || worst === 'expiring';

  const docLabel = doc ? DOC_SHORT[doc.doc_type] ?? doc.doc_type : 'document';
  let reason: string;
  if (worst === 'none' || worst === 'valid') {
    reason = 'All tracked compliance documents are current — no action needed.';
  } else if (worst === 'expiring') {
    reason = `${docLabel} is expiring soon — schedule a renewal chase before it lapses.`;
  } else {
    const verb = worst === 'expired' ? 'has expired' : 'is missing';
    const exposure = onHold && openBillsCents > 0 ? ` with ${money(openBillsCents)} open A/P blocked` : '';
    const gate = hasActiveOverride
      ? ' An override is currently lifting the payment hold.'
      : ' Payments are blocked until it is cured or overridden.';
    reason = `${docLabel} ${verb}${exposure}.${gate}`;
  }

  return { score, confidence, tier, priority, worstState: worst, reason, tierReason, chaseRecommended };
}

/** Stable comparator: most-urgent (highest score) first, exposure as tiebreak. */
export function byRiskDesc(a: { score: number; openBillsCents: number }, b: { score: number; openBillsCents: number }): number {
  return b.score - a.score || b.openBillsCents - a.openBillsCents;
}

export { STATE_ORDER };
