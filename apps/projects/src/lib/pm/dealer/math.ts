/**
 * Client-side mirrors of the 1109 SQL arithmetic, so the desk, the counter and the rental
 * screens can preview a change before it is saved. Each function is a line-for-line port of
 * its SQL source and is parity-tested (src/__tests__/dealer-math.test.ts). The server's answer
 * always wins once a change is saved. Pure; integer cents throughout.
 */
import type {
  AgingBucket, DealLineType, DealTotals, DepositStatus, RentalCharge, RentalRateRow, RoLineKind, RoPayType, TradeStatus,
} from './types';

// ---------------------------------------------------------------- rounding
/**
 * round(qty × unit price) the way Postgres rounds a numeric (half away from zero), exactly.
 * qty is numeric(12,4); the product is done in BigInt on ten-thousandths so 1.0005 × 3 never
 * picks up float error.
 */
export function lineAmountCents(qty: number, unitPriceCents: number): number {
  const q = BigInt(Math.round(qty * 10_000));
  const p = BigInt(Math.round(unitPriceCents));
  const prod = q * p;
  const neg = prod < 0n;
  const abs = neg ? -prod : prod;
  const r = (abs + 5_000n) / 10_000n;
  return Number(neg ? -r : r);
}

/** Postgres round(numeric) for a non-integer value: half away from zero. */
export function pgRound(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** round(x, 4) for a ratio, as numeric. */
function round4(n: number): number {
  return pgRound(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------- deal totals (pm.dealer_deal_totals)
export interface TotalsLine {
  line_type: DealLineType;
  /** The stored amount; computed from qty × unit price when omitted (a draft line). */
  amount_cents?: number;
  qty?: number;
  unit_price_cents?: number;
  cost_cents: number;
  taxable: boolean;
}
export interface TotalsTrade {
  status: TradeStatus;
  acv_cents: number | null;
  allowance_cents: number;
  payoff_cents: number;
}
export interface TotalsInput {
  lines: ReadonlyArray<TotalsLine>;
  trades: ReadonlyArray<TotalsTrade>;
  fi: ReadonlyArray<{ price_cents: number; cost_cents: number }>;
  deposits: ReadonlyArray<{ status: DepositStatus; amount_cents: number }>;
  finance_reserve_cents: number;
  subvention_cents: number;
  tax_rate_estimate: number | null;
  tax_exempt: boolean;
  /** dealer_settings.trade_reduces_taxable (default true). */
  trade_reduces_taxable: boolean;
}

/** dealer_trades.over_allowance_cents (generated column). */
export function overAllowanceCents(t: Pick<TotalsTrade, 'acv_cents' | 'allowance_cents'>): number {
  return t.acv_cents == null ? 0 : Math.max(t.allowance_cents - t.acv_cents, 0);
}

function amountOf(l: TotalsLine): number {
  return l.amount_cents ?? lineAmountCents(l.qty ?? 1, l.unit_price_cents ?? 0);
}

/**
 * The SQL formula, term for term:
 *   sale price  = Σ UNIT + ATTACHMENT − Σ DISCOUNT
 *   front gross = sale − pinned unit/attachment cost − trade over-allowance + fees − fee cost + dealer incentives
 *   back gross  = F&I price − F&I cost + finance reserve − subvention
 *   tax (estimate) = round(max(taxable lines − taxable discounts − trade allowance when the state allows, 0) × rate)
 *   cash price  = sale + fees + F&I + tax − customer rebates
 *   balance     = cash price − trade allowance + trade payoff − deposits
 */
export function computeDealTotals(i: TotalsInput): DealTotals {
  let merch = 0, disc = 0, cost = 0, fees = 0, feeCost = 0, reb = 0, inc = 0, taxGross = 0, taxDisc = 0, units = 0;
  for (const l of i.lines) {
    const a = amountOf(l);
    switch (l.line_type) {
      case 'UNIT':
      case 'ATTACHMENT':
        merch += a;
        cost += l.cost_cents;
        if (l.taxable) taxGross += a;
        if (l.line_type === 'UNIT') units += 1;
        break;
      case 'DISCOUNT':
        disc += a;
        if (l.taxable) taxDisc += a;
        break;
      case 'FEE':
        fees += a;
        feeCost += l.cost_cents;
        if (l.taxable) taxGross += a;
        break;
      case 'REBATE':
        reb += a;
        break;
      case 'INCENTIVE':
        inc += a;
        break;
    }
  }
  let allow = 0, acv = 0, over = 0, payoff = 0, tradeN = 0;
  for (const t of i.trades) {
    if (t.status !== 'APPRAISED' && t.status !== 'RECEIVED') continue;
    allow += t.allowance_cents;
    acv += t.acv_cents ?? 0;
    over += overAllowanceCents(t);
    payoff += t.payoff_cents;
    tradeN += 1;
  }
  let fiPrice = 0, fiCost = 0;
  for (const f of i.fi) {
    fiPrice += f.price_cents;
    fiCost += f.cost_cents;
  }
  let dep = 0;
  for (const d of i.deposits) if (d.status === 'REQUESTED' || d.status === 'ISSUED' || d.status === 'SUPPRESSED') dep += d.amount_cents;

  const sale = merch - disc;
  const front = sale - cost - over + fees - feeCost + inc;
  const back = fiPrice - fiCost + i.finance_reserve_cents - i.subvention_cents;
  const taxable = Math.max(taxGross - taxDisc - (i.trade_reduces_taxable ? allow : 0), 0);
  const tax = i.tax_exempt ? 0 : pgRound(taxable * (i.tax_rate_estimate ?? 0));
  const cash = sale + fees + fiPrice + tax - reb;
  const bal = cash - allow + payoff - dep;
  return {
    unit_count: units,
    merchandise_cents: merch,
    discount_cents: disc,
    sale_price_cents: sale,
    unit_cost_cents: cost,
    fees_cents: fees,
    fee_cost_cents: feeCost,
    rebates_cents: reb,
    incentives_cents: inc,
    trade_count: tradeN,
    trade_allowance_cents: allow,
    trade_acv_cents: acv,
    over_allowance_cents: over,
    trade_payoff_cents: payoff,
    fi_count: i.fi.length,
    fi_price_cents: fiPrice,
    fi_cost_cents: fiCost,
    finance_reserve_cents: i.finance_reserve_cents,
    subvention_cents: i.subvention_cents,
    front_gross_cents: front,
    back_gross_cents: back,
    total_gross_cents: front + back,
    front_gross_pct: sale > 0 ? round4(front / sale) : null,
    taxable_estimate_cents: taxable,
    tax_rate_estimate: i.tax_rate_estimate,
    tax_estimate_cents: tax,
    tax_exempt: i.tax_exempt,
    deposits_cents: dep,
    cash_price_cents: cash,
    balance_due_estimate_cents: bal,
  };
}

/** Is a deal below the floor approve_deal enforces (percent of sale, or minimum front gross)? */
export function belowMarginFloor(t: Pick<DealTotals, 'front_gross_pct' | 'front_gross_cents'>, s: { margin_floor_pct: number; min_front_gross_cents: number }): boolean {
  return (t.front_gross_pct != null && t.front_gross_pct < s.margin_floor_pct) || t.front_gross_cents < s.min_front_gross_cents;
}

// ---------------------------------------------------------------- rentals (pm.rental_charge)
const GRACE_SECONDS = 3540;

/**
 * 28-day months, 7-day weeks, then days; each tier capped by the next (days never cost more
 * than a week, weeks + days never more than a month). Missing rates derive (week = 7 × day,
 * month = 4 × week). Whole 24-hour days, minimum 1, with a 59-minute return grace.
 */
export function rentalCharge(dayCents: number | null, weekCents: number | null, monthCents: number | null, start: string | number | Date, end: string | number | Date): RentalCharge {
  const s = toMs(start);
  const e = toMs(end);
  if (e <= s) return { days: 0, months: 0, weeks: 0, extra_days: 0, rental_cents: 0 };
  let d: number | null = dayCents ? dayCents : null;
  let wk: number | null = weekCents ? weekCents : d == null ? null : d * 7;
  const mo: number | null = monthCents ? monthCents : wk == null ? null : wk * 4;
  d = d ?? (wk != null ? Math.ceil(wk / 7) : mo != null ? Math.ceil(mo / 28) : null);
  wk = wk ?? (mo != null ? mo / 4 : null);
  if (d == null || wk == null || mo == null) throw new Error('A rental needs at least one rate.');
  const secs = (e - s) / 1000;
  const days = Math.max(1, Math.ceil((secs - GRACE_SECONDS) / 86_400));
  const m = Math.floor(days / 28);
  const w = Math.floor((days % 28) / 7);
  const xd = days % 7;
  const dpart = Math.min(xd * d, wk);
  const rest = Math.min(w * wk + dpart, mo);
  return {
    days, months: m, weeks: w, extra_days: xd,
    rate_day_cents: pgRound(d), rate_week_cents: pgRound(wk), rate_month_cents: pgRound(mo),
    rental_cents: pgRound(m * mo + rest),
  };
}

function toMs(v: string | number | Date): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : v.getTime();
}

/** "1 week + 2 days" for a charge breakdown. */
export function chargeWords(c: Pick<RentalCharge, 'months' | 'weeks' | 'extra_days'>): string {
  const parts: string[] = [];
  if (c.months) parts.push(`${c.months} ${c.months === 1 ? 'month' : 'months'}`);
  if (c.weeks) parts.push(`${c.weeks} ${c.weeks === 1 ? 'week' : 'weeks'}`);
  if (c.extra_days) parts.push(`${c.extra_days} ${c.extra_days === 1 ? 'day' : 'days'}`);
  return parts.join(' + ') || '0 days';
}

/**
 * pm.dealer_rental_rate: the most specific active rate that covers the unit (unit, then model,
 * then category, then the company default), newest first within a tier.
 */
export function pickRentalRate(
  rates: ReadonlyArray<RentalRateRow>,
  unit: { id: string; location_id: string; model: string | null; category: string | null },
): RentalRateRow | null {
  const ok = rates.filter((r) =>
    r.is_active && r.location_id === unit.location_id
    && (r.asset_id == null || r.asset_id === unit.id)
    && (r.model == null || r.model.toLowerCase() === (unit.model ?? '').toLowerCase())
    && (r.category == null || r.category === unit.category));
  ok.sort((a, b) =>
    Number(b.asset_id != null) - Number(a.asset_id != null)
    || Number(b.model != null) - Number(a.model != null)
    || Number(b.category != null) - Number(a.category != null)
    || Date.parse(b.created_at) - Date.parse(a.created_at));
  return ok[0] ?? null;
}

/** '["2026-10-20 14:00:00+00","2026-10-22 14:00:00+00")' → epoch ms bounds. */
export function parseRange(range: string | null | undefined): { start: number; end: number } | null {
  if (!range) return null;
  const m = /^[[(]\s*"?([^",]+)"?\s*,\s*"?([^",\])]+)"?\s*[\])]$/.exec(range.trim());
  if (!m) return null;
  const start = Date.parse(m[1]!.replace(' ', 'T').replace(/\+00$/, 'Z'));
  const end = Date.parse(m[2]!.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

/** Time utilization (days on rent ÷ days available), null when the unit had no time in the fleet. */
export function utilization(onRentDays: number, availableDays: number): number | null {
  return availableDays > 0 ? Math.min(onRentDays / availableDays, 1) : null;
}

// ---------------------------------------------------------------- service (the DEALER_RO_CLOSED split)
export interface SplitBucket {
  labor_cents: number;
  parts_cents: number;
  sublet_cents: number;
  misc_cents: number;
  total_cents: number;
  parts_cost_cents: number;
  sublet_cost_cents: number;
  flag_hours: number;
  line_count: number;
}
export type PaySplit = Record<RoPayType, SplitBucket>;

const ZERO: SplitBucket = { labor_cents: 0, parts_cents: 0, sublet_cents: 0, misc_cents: 0, total_cents: 0, parts_cost_cents: 0, sublet_cost_cents: 0, flag_hours: 0, line_count: 0 };

export interface SplitLine {
  kind: RoLineKind;
  pay_type: RoPayType;
  status: 'PROPOSED' | 'APPROVED' | 'DECLINED';
  amount_cents: number;
  qty: number;
  unit_cost_cents: number | null;
  flag_hours: number | null;
}

/** Approved lines by pay type, exactly as pm.dealer_on_ro_closed builds `split`. */
export function paySplit(lines: ReadonlyArray<SplitLine>): PaySplit {
  const out: PaySplit = { CUSTOMER: { ...ZERO }, WARRANTY: { ...ZERO }, INTERNAL: { ...ZERO }, POLICY: { ...ZERO } };
  for (const l of lines) {
    if (l.status !== 'APPROVED') continue;
    const b = out[l.pay_type];
    const labor = l.kind === 'LABOR' || l.kind === 'SERVICE';
    if (labor) {
      b.labor_cents += l.amount_cents;
      b.flag_hours = Math.round((b.flag_hours + (l.flag_hours ?? 0)) * 100) / 100;
    } else if (l.kind === 'PART') {
      b.parts_cents += l.amount_cents;
      b.parts_cost_cents += pgRound(l.qty * (l.unit_cost_cents ?? 0));
    } else if (l.kind === 'SUBLET') {
      b.sublet_cents += l.amount_cents;
      b.sublet_cost_cents += pgRound(l.qty * (l.unit_cost_cents ?? 0));
    } else {
      b.misc_cents += l.amount_cents;
    }
    b.total_cents += l.amount_cents;
    b.line_count += 1;
  }
  return out;
}

/** The split's grand total (every pay type). */
export function splitTotal(s: PaySplit): number {
  return s.CUSTOMER.total_cents + s.WARRANTY.total_cents + s.INTERNAL.total_cents + s.POLICY.total_cents;
}

// ---------------------------------------------------------------- parts
/** pm.resolve_part: follow superseded_by_part_id to the current number (at most 25 hops). */
export function walkSupersession(startId: string, byId: ReadonlyMap<string, { id: string; superseded_by_part_id: string | null }>): { resolvedId: string; chain: string[] } {
  const chain = [startId];
  let cur = startId;
  for (let i = 0; i < 25; i++) {
    const next = byId.get(cur)?.superseded_by_part_id ?? null;
    if (!next || chain.includes(next)) break;
    chain.push(next);
    cur = next;
  }
  return { resolvedId: cur, chain };
}

export interface CounterPart {
  id: string;
  part_number: string;
  manufacturer: string | null;
  description: string;
  status: 'ACTIVE' | 'SUPERSEDED' | 'OBSOLETE';
}

/** What the counter shows after a part number is keyed (the supersession UI state). */
export type CounterLookup =
  | { kind: 'empty' }
  | { kind: 'not_found'; keyed: string; message: string }
  | { kind: 'choose'; keyed: string; options: CounterPart[]; message: string }
  | { kind: 'found'; keyed: string; part: CounterPart; message: string | null }
  | { kind: 'superseded'; keyed: string; requested: CounterPart; part: CounterPart; chain: string[]; message: string }
  | { kind: 'obsolete'; keyed: string; part: CounterPart; message: string };

export interface CounterMatch {
  requested: CounterPart;
  resolved: CounterPart;
  /** Part numbers from the keyed number to the current one. */
  chain: string[];
}

/** Turn the server's matches for a keyed number into the state the counter renders. */
export function counterLookup(keyed: string, matches: ReadonlyArray<CounterMatch>): CounterLookup {
  const k = keyed.trim().toUpperCase();
  if (!k) return { kind: 'empty' };
  if (matches.length === 0) return { kind: 'not_found', keyed: k, message: `No part ${k} in the catalog. Check the number, or add it to the catalog.` };
  const distinct = new Map<string, CounterMatch>();
  for (const m of matches) if (!distinct.has(m.resolved.id)) distinct.set(m.resolved.id, m);
  if (distinct.size > 1) {
    const opts = [...distinct.values()].map((m) => m.resolved);
    return { kind: 'choose', keyed: k, options: opts, message: `${k} is carried for ${opts.length} manufacturers. Pick the line.` };
  }
  const m = [...distinct.values()][0]!;
  if (m.resolved.id !== m.requested.id) {
    return {
      kind: 'superseded', keyed: k, requested: m.requested, part: m.resolved, chain: m.chain,
      message: `${m.requested.part_number} is replaced by ${m.resolved.part_number}${m.chain.length > 2 ? ` (through ${m.chain.slice(1, -1).join(', ')})` : ''}. The ticket sells ${m.resolved.part_number}.`,
    };
  }
  if (m.resolved.status === 'OBSOLETE') return { kind: 'obsolete', keyed: k, part: m.resolved, message: `${m.resolved.part_number} is obsolete with no replacement on file.` };
  return { kind: 'found', keyed: k, part: m.resolved, message: null };
}

/** "3*AM125172", "3 x AM125172", "AM125172" → quantity and part number. */
export function parseCounterEntry(text: string): { qty: number; pn: string } | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:\*|x|X|×)\s*(\S.*)$/.exec(t);
  if (m) {
    const qty = Number(m[1]);
    const pn = m[2]!.trim().toUpperCase();
    return qty > 0 && pn ? { qty, pn } : null;
  }
  return { qty: 1, pn: t.toUpperCase() };
}

/** How a requested quantity splits against the shelf: fill what is there, special-order the rest. */
export function fillPlan(requested: number, onHand: number, allowNegative: boolean): { filled: number; short: number } {
  if (allowNegative) return { filled: requested, short: 0 };
  const filled = Math.max(0, Math.min(requested, Math.floor(onHand * 10_000) / 10_000));
  return { filled, short: Math.round((requested - filled) * 10_000) / 10_000 };
}

/** Counter-ticket totals the way pm.close_parts_ticket computes them (sold lines only). */
export function ticketTotals(lines: ReadonlyArray<{ qty_filled: number; unit_price_cents: number; core_charge_cents: number; taxable: boolean; unit_cost_cents: number | null }>, taxRate: number | null, exempt: boolean) {
  let parts = 0, cores = 0, cost = 0, taxable = 0;
  for (const l of lines) {
    if (l.qty_filled <= 0) continue;
    const a = lineAmountCents(l.qty_filled, l.unit_price_cents);
    parts += a;
    cores += pgRound(l.qty_filled * l.core_charge_cents);
    cost += pgRound(l.qty_filled * (l.unit_cost_cents ?? 0));
    if (l.taxable) taxable += a;
  }
  const tax = exempt ? 0 : pgRound(taxable * (taxRate ?? 0));
  return { parts_cents: parts, core_charges_cents: cores, cost_cents: cost, taxable_estimate_cents: taxable, tax_estimate_cents: tax, total_estimate_cents: parts + cores + tax };
}

// ---------------------------------------------------------------- units
/** v_dealer_unit_inventory.aging_bucket. */
export function agingBucket(days: number | null | undefined): AgingBucket | null {
  if (days == null) return null;
  if (days <= 90) return '0-90';
  if (days <= 180) return '91-180';
  if (days <= 365) return '181-365';
  return '365+';
}

/** Units that count toward aged_inventory_count_over_180. */
export function isAged(u: { unit_status: string; days_in_stock: number | null }): boolean {
  return ['IN_STOCK', 'PDI', 'DEMO', 'ON_HOLD'].includes(u.unit_status) && (u.days_in_stock ?? 0) > 180;
}
