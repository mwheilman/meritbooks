/**
 * MeritBooks subscription pricing — the deterministic billing MODEL.
 *
 * PURE functions over integer cents. No I/O, no database, no clock, no live charging.
 * This module is the single source of truth for "what does a plan cost per month"; both
 * the Operator Console (cross-tenant list-price MRR) and the tenant's own plan page read
 * their numbers from here so the two can never disagree.
 *
 * IMPORTANT: computing a price is NOT charging for it. Nothing here moves money or touches
 * Stripe. Live tenant billing (creating subscriptions/invoices) is a separate, gated step.
 *
 * APPROVED PRICING (Owner-approved):
 *   • Direct     — $99/company/mo for the first 5 companies, $59/company/mo for the 6th onward.
 *   • Firm       — $499/mo platform fee + wholesale per client entity, volume-tiered
 *                  (MARGINAL tiers): $59 (clients 1–25), $49 (26–100), $39 (101+).
 *   • Enterprise — custom monthly amount when set; otherwise falls back to the direct formula.
 *   • Usage      — ACH billed 1% (uncapped), card 3%. INFORMATIONAL on the plan page; the
 *                  operator realizes this via its own processor fee, not a subscription line.
 *
 * All money is integer cents. Counts are whole entities (companies for direct/enterprise,
 * client entities for firm).
 */

export type BillingPlan = 'direct' | 'firm' | 'enterprise';

export const BILLING_PLANS: readonly BillingPlan[] = ['direct', 'firm', 'enterprise'] as const;

export function isBillingPlan(v: unknown): v is BillingPlan {
  return typeof v === 'string' && (BILLING_PLANS as readonly string[]).includes(v);
}

// ── Pricing constants (integer cents) ────────────────────────────────────────

/** Direct: first N companies at the base rate, the rest at the additional rate. */
export const DIRECT_BASE_CENTS = 9900; // $99.00 / company / mo (companies 1–5)
export const DIRECT_BASE_LIMIT = 5; // the first 5 companies bill at the base rate
export const DIRECT_ADDL_CENTS = 5900; // $59.00 / company / mo (company 6 onward)

/** Firm / white-label: a flat platform fee plus a marginal-tiered wholesale per client. */
export const FIRM_PLATFORM_FEE_CENTS = 49900; // $499.00 / mo platform fee

/**
 * Marginal wholesale tiers for the firm plan. Each tier prices the clients that fall
 * WITHIN its band (marginal, not a flat rate applied to the whole count). `upTo` is the
 * inclusive upper bound of the band; the final tier is open-ended (Infinity).
 */
export interface WholesaleTier {
  readonly upTo: number; // inclusive upper bound of this band
  readonly unitCents: number; // per-client monthly rate within the band
  readonly label: string;
}
export const FIRM_WHOLESALE_TIERS: readonly WholesaleTier[] = [
  { upTo: 25, unitCents: 5900, label: 'Clients 1–25' },
  { upTo: 100, unitCents: 4900, label: 'Clients 26–100' },
  { upTo: Infinity, unitCents: 3900, label: 'Clients 101+' },
] as const;

/** The Enterprise plan is "custom (25+)"; used only for UI copy / thresholds. */
export const ENTERPRISE_MIN_COMPANIES = 25;

/**
 * Usage-based rates (basis points of processed volume). INFORMATIONAL only — surfaced on
 * the plan page so a tenant understands processing economics; never part of subscription MRR.
 */
export const USAGE_RATES_BPS = {
  ach: 100, // 1.0% of ACH volume (uncapped)
  card: 300, // 3.0% of card volume
} as const;

// ── Breakdown structures (for the UI) ────────────────────────────────────────

/** One priced line within a plan's monthly bill (a company band, a platform fee, etc.). */
export interface PricingLine {
  label: string;
  quantity: number; // entities in this line (0 for a flat fee line)
  unitCents: number; // per-entity monthly rate (or the flat amount when quantity is 0/1)
  subtotalCents: number; // quantity × unitCents, or the flat amount
  kind: 'platform_fee' | 'tier' | 'custom';
}

/** The full monthly-cost breakdown for a plan at a given entity count. */
export interface MrrBreakdown {
  plan: BillingPlan;
  /** Billable entity count: companies (direct/enterprise) or client entities (firm). */
  count: number;
  lines: PricingLine[];
  mrrCents: number; // monthly recurring, integer cents
  arrCents: number; // mrrCents × 12
  /** True when the amount came from a stored custom figure rather than the formula. */
  usesCustom: boolean;
}

// ── Core computations ────────────────────────────────────────────────────────

const nonNegInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Direct plan monthly cost: first 5 companies at $99, each additional at $59.
 * e.g. 1→$99, 5→$495, 6→$554, 17→$1,203, 25→$1,675.
 */
export function directMrrCents(companyCount: number): number {
  const n = nonNegInt(companyCount);
  const base = Math.min(n, DIRECT_BASE_LIMIT);
  const addl = Math.max(n - DIRECT_BASE_LIMIT, 0);
  return base * DIRECT_BASE_CENTS + addl * DIRECT_ADDL_CENTS;
}

/** Direct plan cost broken into its base + additional lines. */
export function directBreakdown(companyCount: number): MrrBreakdown {
  const n = nonNegInt(companyCount);
  const baseQty = Math.min(n, DIRECT_BASE_LIMIT);
  const addlQty = Math.max(n - DIRECT_BASE_LIMIT, 0);

  const lines: PricingLine[] = [];
  if (baseQty > 0) {
    lines.push({
      label: `First ${DIRECT_BASE_LIMIT} companies`,
      quantity: baseQty,
      unitCents: DIRECT_BASE_CENTS,
      subtotalCents: baseQty * DIRECT_BASE_CENTS,
      kind: 'tier',
    });
  }
  if (addlQty > 0) {
    lines.push({
      label: `Additional companies (6+)`,
      quantity: addlQty,
      unitCents: DIRECT_ADDL_CENTS,
      subtotalCents: addlQty * DIRECT_ADDL_CENTS,
      kind: 'tier',
    });
  }
  const mrrCents = directMrrCents(n);
  return { plan: 'direct', count: n, lines, mrrCents, arrCents: mrrCents * 12, usesCustom: false };
}

/**
 * Sum the marginal wholesale for `clientCount` client entities across the firm tiers.
 * (Excludes the platform fee.)
 */
export function firmWholesaleCents(clientCount: number): number {
  const n = nonNegInt(clientCount);
  let remaining = n;
  let prevBound = 0;
  let total = 0;
  for (const tier of FIRM_WHOLESALE_TIERS) {
    if (remaining <= 0) break;
    const band = tier.upTo === Infinity ? remaining : Math.max(0, Math.min(tier.upTo - prevBound, remaining));
    total += band * tier.unitCents;
    remaining -= band;
    prevBound = tier.upTo;
  }
  return total;
}

/**
 * Firm / white-label plan monthly cost: $499 platform fee + marginal-tiered wholesale.
 * e.g. 25→$1,974, 26→$2,023, 100→$5,649, 101→$5,688.
 */
export function firmMrrCents(clientCount: number): number {
  return FIRM_PLATFORM_FEE_CENTS + firmWholesaleCents(clientCount);
}

/** Firm plan cost broken into the platform fee + each populated wholesale band. */
export function firmBreakdown(clientCount: number): MrrBreakdown {
  const n = nonNegInt(clientCount);
  const lines: PricingLine[] = [
    {
      label: 'Platform fee',
      quantity: 0,
      unitCents: FIRM_PLATFORM_FEE_CENTS,
      subtotalCents: FIRM_PLATFORM_FEE_CENTS,
      kind: 'platform_fee',
    },
  ];

  let remaining = n;
  let prevBound = 0;
  for (const tier of FIRM_WHOLESALE_TIERS) {
    if (remaining <= 0) break;
    const band = tier.upTo === Infinity ? remaining : Math.max(0, Math.min(tier.upTo - prevBound, remaining));
    if (band > 0) {
      lines.push({
        label: tier.label,
        quantity: band,
        unitCents: tier.unitCents,
        subtotalCents: band * tier.unitCents,
        kind: 'tier',
      });
    }
    remaining -= band;
    prevBound = tier.upTo;
  }

  const mrrCents = firmMrrCents(n);
  return { plan: 'firm', count: n, lines, mrrCents, arrCents: mrrCents * 12, usesCustom: false };
}

/**
 * Enterprise plan monthly cost: the stored custom amount when set (>= 0), otherwise the
 * direct formula as a fallback.
 */
export function enterpriseMrrCents(companyCount: number, customCents?: number | null): number {
  if (customCents != null && Number.isFinite(customCents) && customCents >= 0) {
    return Math.floor(customCents);
  }
  return directMrrCents(companyCount);
}

export function enterpriseBreakdown(companyCount: number, customCents?: number | null): MrrBreakdown {
  const n = nonNegInt(companyCount);
  const hasCustom = customCents != null && Number.isFinite(customCents) && customCents >= 0;
  if (hasCustom) {
    const amt = Math.floor(customCents as number);
    return {
      plan: 'enterprise',
      count: n,
      lines: [
        {
          label: 'Custom enterprise agreement',
          quantity: 0,
          unitCents: amt,
          subtotalCents: amt,
          kind: 'custom',
        },
      ],
      mrrCents: amt,
      arrCents: amt * 12,
      usesCustom: true,
    };
  }
  // Fallback: price like the direct plan but keep the enterprise label.
  const base = directBreakdown(n);
  return { ...base, plan: 'enterprise', usesCustom: false };
}

/**
 * Dispatch: monthly cost for any plan at a given entity count (+ optional custom cents,
 * used only by the enterprise plan).
 */
export function planMrrCents(plan: BillingPlan, count: number, customCents?: number | null): number {
  switch (plan) {
    case 'firm':
      return firmMrrCents(count);
    case 'enterprise':
      return enterpriseMrrCents(count, customCents);
    case 'direct':
    default:
      return directMrrCents(count);
  }
}

/** Dispatch: full breakdown for any plan. */
export function planBreakdown(plan: BillingPlan, count: number, customCents?: number | null): MrrBreakdown {
  switch (plan) {
    case 'firm':
      return firmBreakdown(count);
    case 'enterprise':
      return enterpriseBreakdown(count, customCents);
    case 'direct':
    default:
      return directBreakdown(count);
  }
}

/** Informational usage fee for a processed amount on a given rail (integer cents). */
export function usageFeeCents(amountCents: number, rail: 'ach' | 'card'): number {
  const amt = nonNegInt(amountCents);
  return Math.round((amt * USAGE_RATES_BPS[rail]) / 10000);
}

// ── Org helper ───────────────────────────────────────────────────────────────

/** The minimal org shape the pricing model reads. */
export interface OrgBillingShape {
  billing_plan?: string | null;
  custom_mrr_cents?: number | string | null;
}

export interface ResolvedPlan {
  plan: BillingPlan;
  customCents: number | null;
}

/**
 * Normalize an org row's billing fields into a safe { plan, customCents }. Unknown or
 * missing plans fall back to 'direct'; a non-numeric custom amount becomes null.
 */
export function planFor(org: OrgBillingShape | null | undefined): ResolvedPlan {
  const rawPlan = org?.billing_plan;
  const plan: BillingPlan = isBillingPlan(rawPlan) ? rawPlan : 'direct';
  const rawCustom = org?.custom_mrr_cents;
  const num = rawCustom == null ? NaN : Number(rawCustom);
  const customCents = Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
  return { plan, customCents };
}

/** Convenience: resolve an org's plan and compute its breakdown for `count` entities. */
export function orgBreakdown(org: OrgBillingShape | null | undefined, count: number): MrrBreakdown {
  const { plan, customCents } = planFor(org);
  return planBreakdown(plan, count, customCents);
}
