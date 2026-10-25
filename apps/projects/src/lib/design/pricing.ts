/**
 * Design pricing rules (ID-14) — the mirror of migration 1124's pm.dsn_price unit math, so the item
 * editor previews the client price the database will store. Integer cents, half-up.
 *   COST_PLUS              cost × (1 + pct)
 *   DISCOUNT_FROM_RETAIL   retail × (1 − pct)
 *   TIERED                 cost × (1 + pct of the first tier whose up_to ≥ cost; last tier open)
 *   no rule                cost × (1 + the firm's default markup)
 * Pure; unit-tested.
 */

export type PricingMethod = 'COST_PLUS' | 'DISCOUNT_FROM_RETAIL' | 'TIERED';

export interface PricingRule {
  method: PricingMethod;
  pct: number | null;
  tiers?: ReadonlyArray<{ up_to_cents: number | null; pct: number }>;
}

export function halfUp(n: number): number {
  return n >= 0 ? Math.floor(n + 0.5 + 1e-9) : -Math.floor(-n + 0.5 + 1e-9);
}

export function priceUnit(rule: PricingRule | null, costCents: number | null, retailCents: number | null, defaultMarkup = 0.35): number {
  const cost = costCents ?? 0;
  if (!rule) return halfUp(cost * (1 + defaultMarkup));
  if (rule.method === 'COST_PLUS') return halfUp(cost * (1 + (rule.pct ?? 0)));
  if (rule.method === 'DISCOUNT_FROM_RETAIL') {
    if (retailCents == null) throw new Error('This rule prices from retail; the item has no retail price.');
    return halfUp(retailCents * (1 - (rule.pct ?? 0)));
  }
  const tiers = [...(rule.tiers ?? [])].sort((a, b) => (a.up_to_cents ?? Number.MAX_SAFE_INTEGER) - (b.up_to_cents ?? Number.MAX_SAFE_INTEGER));
  const tier = tiers.find((t) => t.up_to_cents == null || cost <= t.up_to_cents);
  return halfUp(cost * (1 + (tier?.pct ?? rule.pct ?? 0)));
}

/** Realized markup on cost (null without cost). */
export function markupOf(sellCents: number, costCents: number): number | null {
  return costCents > 0 ? Math.round(((sellCents - costCents) / costCents) * 10000) / 10000 : null;
}
