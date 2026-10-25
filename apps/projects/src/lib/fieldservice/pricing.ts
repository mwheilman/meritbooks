/**
 * Flat-rate price formulas (FS-45) — the exact mirror of migration 1117's pm.fs_* functions.
 * Integer cents, half-up division on BigInt (never floating point), so a preview in the browser
 * and the stored price in the database are always the same number. Pure; unit-tested for parity.
 *
 *   service     = rule( hours × burdened rate ÷ (1 − target GM) + Σ round(qty × unit cost × (1 + ladder(unit cost))) )
 *   material    = rule( round(cost × (1 + ladder(cost))) )
 *   equipment   = rule( round(cost ÷ (1 − equipment GM)) )
 *   member      = min(price, rule( round(price × (1 − member %)) ))
 *   after hours = rule( round(price × multiplier) )
 */

export type RoundingRule = 'NONE' | 'WHOLE' | 'FIVE' | 'NINE';
export type PriceKind = 'SERVICE' | 'MATERIAL' | 'EQUIPMENT' | 'FEE' | 'MEMBERSHIP';

export interface MarkupTier {
  /** Highest unit cost (cents) this tier covers; null = everything above the last tier. */
  upToCents: number | null;
  /** Markup as a fraction: 1.25 = +125 %. */
  markupPct: number;
}

export interface PriceSettings {
  burdenedRateCents: number;
  targetGmPct: number;
  equipmentGmPct: number;
  memberDiscountPct: number;
  afterHoursMultiplier: number;
  rounding: RoundingRule;
}

export const DEFAULT_PRICE_SETTINGS: PriceSettings = {
  burdenedRateCents: 9500,
  targetGmPct: 0.55,
  equipmentGmPct: 0.35,
  memberDiscountPct: 0.15,
  afterHoursMultiplier: 1.5,
  rounding: 'NINE',
};

export interface BundledMaterial {
  qty: number;
  unitCostCents: number;
}

export interface PriceInput {
  kind: PriceKind;
  taskHours?: number | null;
  costCents?: number | null;
  targetGmPct?: number | null;
  priceLocked?: boolean;
  currentPriceCents?: number;
  materials?: ReadonlyArray<BundledMaterial>;
}

export interface PriceResult {
  priceCents: number;
  memberPriceCents: number;
  afterHoursPriceCents: number;
  laborCostCents: number;
  materialCostCents: number;
  /** Total cost behind the price (labor + materials for a service; the item cost otherwise). */
  costCents: number;
  /** (price − cost) ÷ price, 4 places; null at a zero price. */
  marginPct: number | null;
}

// ------------------------------------------------------------------ exact decimal helpers

/** A decimal as an integer over 10^scale (exact for the values the forms produce). */
function scaled(x: number, scale: number): bigint {
  if (!Number.isFinite(x)) throw new RangeError('not a finite number');
  const neg = x < 0;
  const [whole, frac = ''] = Math.abs(x).toFixed(Math.min(scale + 2, 20)).split('.');
  const padded = (frac + '0'.repeat(scale + 2)).slice(0, scale + 2);
  // round the two guard digits half-up into the scale
  const raw = BigInt((whole ?? '0') + padded);
  const v = (raw + 50n) / 100n;
  return neg ? -v : v;
}

/** Half-up integer division for a non-negative numerator (SQL: div(2n + d, 2d)). */
export function rdiv(n: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  return (2n * n + d) / (2n * d);
}

const toNum = (b: bigint): number => Number(b);

// ------------------------------------------------------------------ rules

export function roundRule(cents: number, rule: RoundingRule): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  const c = Math.round(cents);
  switch (rule) {
    case 'WHOLE':
      return Math.ceil(c / 100) * 100;
    case 'FIVE':
      return Math.ceil(c / 500) * 500;
    case 'NINE': {
      let d = Math.ceil(c / 100);
      d += ((9 - (d % 10)) + 10) % 10;
      return d * 100;
    }
    default:
      return c;
  }
}

/** The ladder markup for a unit cost: the tier with the smallest bound ≥ cost; 0 without tiers. */
export function ladderMarkup(costCents: number, ladder: ReadonlyArray<MarkupTier>): number {
  const sorted = [...ladder].sort((a, b) => (a.upToCents ?? Number.POSITIVE_INFINITY) - (b.upToCents ?? Number.POSITIVE_INFINITY));
  const t = sorted.find((x) => x.upToCents === null || x.upToCents >= costCents);
  return t ? t.markupPct : 0;
}

/** round(qty × cost × (1 + markup)) — qty to 3 places, markup to 4. */
export function materialSell(qty: number, unitCostCents: number, ladder: ReadonlyArray<MarkupTier>): number {
  const q = scaled(qty, 3);
  const m = scaled(ladderMarkup(unitCostCents, ladder), 4);
  return toNum(rdiv(q * BigInt(Math.round(unitCostCents)) * (10000n + m), 1000n * 10000n));
}

/** round(qty × cost). */
export function materialCost(qty: number, unitCostCents: number): number {
  return toNum(rdiv(scaled(qty, 3) * BigInt(Math.round(unitCostCents)), 1000n));
}

/** hours × rate ÷ (1 − GM) + material sell, then the rounding rule. */
export function servicePrice(hours: number, rateCents: number, gmPct: number, materialSellCents: number, rule: RoundingRule): number {
  const h = scaled(hours, 2);
  const g = scaled(Math.min(gmPct, 0.95), 4);
  const labor = rdiv(h * BigInt(Math.round(rateCents)) * 100n, 10000n - g);
  return roundRule(toNum(labor) + materialSellCents, rule);
}

export function memberPrice(priceCents: number, memberPct: number, rule: RoundingRule): number {
  const d = scaled(memberPct, 4);
  const v = roundRule(toNum(rdiv(BigInt(priceCents) * (10000n - d), 10000n)), rule);
  return Math.min(v, priceCents);
}

export function afterHoursPrice(priceCents: number, multiplier: number, rule: RoundingRule): number {
  return roundRule(toNum(rdiv(BigInt(priceCents) * scaled(multiplier, 2), 100n)), rule);
}

/** Percent change of a price (bulk edit): round(price × (1 + pct)) then the rule. */
export function changedPrice(priceCents: number, pctChange: number, rule: RoundingRule): number {
  return roundRule(toNum(rdiv(BigInt(priceCents) * (10000n + scaled(pctChange, 4)), 10000n)), rule);
}

export function marginPct(priceCents: number, costCents: number): number | null {
  if (priceCents <= 0) return null;
  return Math.round(((priceCents - costCents) / priceCents) * 10000) / 10000;
}

/** Price one item exactly as pm._fs_price_item does. */
export function priceItem(input: PriceInput, s: PriceSettings, ladder: ReadonlyArray<MarkupTier>): PriceResult {
  const cost = Math.max(0, Math.round(input.costCents ?? 0));
  let price: number;
  let laborCost = 0;
  let matCost = 0;
  if (input.kind === 'SERVICE') {
    let sell = 0;
    for (const m of input.materials ?? []) {
      sell += materialSell(m.qty, m.unitCostCents, ladder);
      matCost += materialCost(m.qty, m.unitCostCents);
    }
    const hours = input.taskHours ?? 0;
    laborCost = toNum(rdiv(scaled(hours, 2) * BigInt(s.burdenedRateCents), 100n));
    price = servicePrice(hours, s.burdenedRateCents, input.targetGmPct ?? s.targetGmPct, sell, s.rounding);
  } else if (input.kind === 'MATERIAL') {
    matCost = cost;
    price = roundRule(materialSell(1, cost, ladder), s.rounding);
  } else if (input.kind === 'EQUIPMENT') {
    matCost = cost;
    const g = scaled(input.targetGmPct ?? s.equipmentGmPct, 4);
    price = roundRule(toNum(rdiv(BigInt(cost) * 10000n, 10000n - g)), s.rounding);
  } else {
    matCost = cost;
    price = input.currentPriceCents ?? 0;
  }
  if (input.priceLocked) price = input.currentPriceCents ?? price;
  const total = input.kind === 'SERVICE' ? laborCost + matCost : matCost;
  return {
    priceCents: price,
    memberPriceCents: memberPrice(price, s.memberDiscountPct, s.rounding),
    afterHoursPriceCents: afterHoursPrice(price, s.afterHoursMultiplier, s.rounding),
    laborCostCents: laborCost,
    materialCostCents: matCost,
    costCents: total,
    marginPct: marginPct(price, total),
  };
}

// ------------------------------------------------------------------ financing

const E18 = 10n ** 18n;

/**
 * Amortized monthly payment, cents (pm.fs_monthly_payment): r = apr ÷ 12 at 1e18 fixed point,
 * f = (1 + r)^n with half-up rounding at every step; 0 % APR = amount ÷ months.
 */
export function monthlyPayment(amountCents: number, apr: number, months: number): number {
  if (!(amountCents > 0) || !(months > 0)) return 0;
  const amount = BigInt(Math.round(amountCents));
  const n = BigInt(Math.round(months));
  if (!(apr > 0)) return toNum(rdiv(amount, n));
  const r18 = rdiv(scaled(apr, 5) * 10n ** 13n, 12n);
  let f18 = E18;
  for (let i = 0; i < Math.min(months, 600); i++) f18 = rdiv(f18 * (E18 + r18), E18);
  const num = rdiv(amount * r18 * f18, 10n ** 30n);
  const den = rdiv(f18 - E18, 10n ** 12n);
  if (den <= 0n) return toNum(rdiv(amount, n));
  return toNum(rdiv(num, den));
}

/** Option totals as the customer sees them: regular, member, after rebate, monthly. */
export interface OptionMoney {
  regularCents: number;
  memberCents: number;
  rebateCents: number;
  /** The price the customer pays (member when member pricing applies) less rebates. */
  netCents: number;
  monthlyCents: number | null;
}

export function optionMoney(regularCents: number, memberCents: number, rebateCents: number, member: boolean, plan: { apr: number; termMonths: number } | null): OptionMoney {
  const base = member ? memberCents : regularCents;
  const net = Math.max(0, base - rebateCents);
  return {
    regularCents,
    memberCents,
    rebateCents,
    netCents: net,
    monthlyCents: plan ? monthlyPayment(net, plan.apr, plan.termMonths) : null,
  };
}
