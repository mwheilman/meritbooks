/**
 * Labor rate math, client side, to the cent of 1108_pm_parties_and_labor.sql
 * (pm.v_labor_rates, pm.labor_rate_for, pm.price_labor_line, pm.approve_time_entries). Pure.
 *
 * Owner ruling 2026-10-21:
 *   cost rate       = pay × (1 + burden)                  → job cost (what Merit Books books)
 *   estimating rate = pay × (1 + burden) × (1 + overhead) → bids only
 * Overhead is recovered in gross margin and is never charged to the job.
 *
 * Rounding: each rate is rounded ONCE from the exact product, half away from zero (Postgres
 * numeric round); line amounts are hours × the cent rate, rounded once. Everything runs on
 * BigInt over the decimal digits, so 30.00 × 1.25 × 1.15 = 43.125 → $43.13 exactly as SQL.
 */
import { decimalParts } from '@/lib/pm/money/aia';

/** The plain-language rule shown wherever both rates appear. */
export const LABOR_COST_RULE =
  'Job cost uses pay + burden. Estimates add overhead so bids recover it; overhead is earned back in gross margin, never charged to the job.';

export type PayType = 'REG' | 'OT' | 'DT' | 'PIECE' | 'FLAG';

/** pm.pay_type_factor: REG 1, OT 1.5, DT 2; piece and flat rate cost per hour at the base rate. */
export const PAY_TYPE_FACTOR: Readonly<Record<PayType, string>> = { REG: '1', OT: '1.5', DT: '2', PIECE: '1', FLAG: '1' };

/** Round a/b half away from zero (b > 0). */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= b) return a < 0n ? q - 1n : q + 1n;
  return q;
}

/** cents × Π factors, rounded once. Factors are decimals ("0.25", 1.5). */
function product(cents: number, factors: ReadonlyArray<number | string>): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Cents must be an integer: ${cents}`);
  let num = BigInt(cents);
  let scale = 1n;
  for (const f of factors) {
    const d = decimalParts(f);
    num *= d.num;
    scale *= d.scale;
  }
  return Number(divRound(num, scale));
}

/** 1 + p as a decimal string with p's own digits (no float drift). */
function onePlus(p: number | string): string {
  const d = decimalParts(p);
  if (d.num < 0n) throw new RangeError('Percent must be ≥ 0');
  const n = d.scale + d.num;
  const digits = d.scale.toString().length - 1;
  if (digits === 0) return n.toString();
  const s = n.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** round(base × (1 + burden)) — the job-cost rate. */
export function costRateCents(baseCents: number, burdenPct: number | string): number {
  return product(baseCents, [onePlus(burdenPct)]);
}

/** round(base × (1 + burden) × (1 + overhead)) — the estimating rate (bids only). */
export function estimatingRateCents(baseCents: number, burdenPct: number | string, overheadPct: number | string): number {
  return product(baseCents, [onePlus(burdenPct), onePlus(overheadPct)]);
}

/** What approval pins: round(base × (1 + burden) × pay-type factor). Never overhead. */
export function pinnedCostRateCents(baseCents: number, burdenPct: number | string, payType: PayType): number {
  return product(baseCents, [onePlus(burdenPct), PAY_TYPE_FACTOR[payType]]);
}

export interface LaborRates {
  costRateCents: number;
  estimatingRateCents: number;
  overheadRateCents: number;
}

/** Both rates of a card, plus the overhead component (estimating − cost). */
export function laborRates(baseCents: number, burdenPct: number | string, overheadPct: number | string): LaborRates {
  const c = costRateCents(baseCents, burdenPct);
  const e = estimatingRateCents(baseCents, burdenPct, overheadPct);
  return { costRateCents: c, estimatingRateCents: e, overheadRateCents: e - c };
}

export interface LaborLinePrice {
  /** hours × cost rate: the budget / job-cost basis. */
  costCents: number;
  /** hours × estimating rate: what the bid must recover. */
  estimatingCents: number;
  /** estimating − cost: the overhead the bid recovers (earned back in gross margin). */
  overheadCents: number;
}

/** pm.price_labor_line: hours × the CENT rates, each rounded once; components tie. */
export function priceLaborLine(rates: Pick<LaborRates, 'costRateCents' | 'estimatingRateCents'>, hours: number | string): LaborLinePrice {
  const cost = product(rates.costRateCents, [hours]);
  const est = product(rates.estimatingRateCents, [hours]);
  return { costCents: cost, estimatingCents: est, overheadCents: est - cost };
}

/** Effective percent: the card's own, else the company default, else 0 (as in v_labor_rates). */
export function effectivePct(card: number | null | undefined, companyDefault: number | null | undefined): number {
  return card ?? companyDefault ?? 0;
}

/** "25" / "12.75" (percent text) → "0.25" / "0.1275"; null unless 0–500 with up to 2 decimals. */
export function percentTextToFraction(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const hundredths = Number(w) * 100 + Number((f + '00').slice(0, 2));
  if (hundredths > 50_000) return null;
  return hundredths / 10_000;
}

/** A fraction → percent text ("0.1275" → "12.75"). */
export function fractionToPercentText(f: number | null | undefined): string {
  if (f == null) return '';
  return String(Math.round(f * 1_000_000) / 10_000);
}
