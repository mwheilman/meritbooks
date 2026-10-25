/**
 * Commercial money math — the browser mirror of migration 1120's SQL (pm._cm_ret_line,
 * pm._cm_step_rate, pm._cm_markup, the G703 generator and the WIP row). Pure: no I/O.
 * A parity test (packages/projects-access/test/commercial.test.ts) runs both on the same inputs.
 *
 * All money is integer cents (numbers within ±2^53). Rounding is half away from zero, which is
 * Postgres `round(numeric)`.
 */

export function roundCents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(Math.abs(n) + 1e-9);
  return n < 0 ? -r : r;
}

// ------------------------------------------------------------------ retainage

export type RetainageMode = 'NEW_WORK_ONLY' | 'REDUCE_TO_DATE';

export interface RetainageStep {
  fromPct: number;
  rate: number;
}

/** The rate of the highest step at or below `completion`, else `base` (pm._cm_step_rate). */
export function stepRate(steps: ReadonlyArray<RetainageStep>, completion: number, base: number): number {
  let best: RetainageStep | null = null;
  for (const s of steps) if (s.fromPct <= completion && (!best || s.fromPct > best.fromPct)) best = s;
  return best ? best.rate : base;
}

export interface RetainageLineInput {
  mode: RetainageMode;
  rate: number;
  /** Stored-materials rate (null = the work rate). */
  storedRate: number | null;
  /** D previous work, E this period, F stored now, Fp stored before, prev = retainage held to date. */
  previousWork: number;
  thisPeriodWork: number;
  storedNow: number;
  storedBefore: number;
  heldBefore: number;
}

export interface RetainageLine {
  workToDate: number;
  storedToDate: number;
  thisPeriod: number;
}

/** pm._cm_ret_line: retainage on one SOV / commitment line. */
export function retainageLine(i: RetainageLineInput): RetainageLine {
  const srate = i.storedRate ?? i.rate;
  const storedToDate = roundCents(srate * i.storedNow);
  const workToDate = i.mode === 'REDUCE_TO_DATE'
    ? roundCents(i.rate * (i.previousWork + i.thisPeriodWork))
    : i.heldBefore - roundCents(srate * i.storedBefore) + roundCents(i.rate * i.thisPeriodWork);
  return { workToDate, storedToDate, thisPeriod: workToDate + storedToDate - i.heldBefore };
}

// ------------------------------------------------------------------ G703 continuation sheet

export interface G703Input {
  scheduled: number;
  previousWork: number;
  previousStored: number;
  /** One of: completion fraction 0..1 of the scheduled value (work only), work to date, or this period. */
  pctComplete?: number;
  workToDate?: number;
  thisPeriod?: number;
  /** Stored balance now; defaults to the previous stored balance (carry forward). */
  storedNow?: number;
}

export interface G703Line {
  scheduled: number;          // C
  previousWork: number;       // D
  thisPeriodWork: number;     // E
  storedNow: number;          // F
  previousStored: number;     // F'
  totalCompleted: number;     // G = D + E + F
  pct: number | null;         // G / C
  balanceToFinish: number;    // H = C − G
  billedThisPeriod: number;   // E + F − F'
}

export class G703Error extends Error {
  constructor(public readonly code: 'NEGATIVE' | 'OVER_SCHEDULED' | 'PCT', message: string) {
    super(message);
    this.name = 'G703Error';
  }
}

/** The pm.generate_sov_billing per-line math (throws the same refusals). */
export function g703Line(i: G703Input): G703Line {
  let e = 0;
  if (i.pctComplete !== undefined) {
    if (i.pctComplete < 0 || i.pctComplete > 1) throw new G703Error('PCT', 'Percent complete must be between 0 and 100.');
    e = roundCents(i.scheduled * i.pctComplete) - i.previousWork;
  } else if (i.workToDate !== undefined) {
    e = i.workToDate - i.previousWork;
  } else if (i.thisPeriod !== undefined) {
    e = i.thisPeriod;
  }
  const f = i.storedNow ?? i.previousStored;
  if (i.previousWork + e < 0 || f < 0) throw new G703Error('NEGATIVE', 'A line cannot go below zero.');
  const g = i.previousWork + e + f;
  if (g > i.scheduled) throw new G703Error('OVER_SCHEDULED', 'Completed and stored cannot exceed the scheduled value.');
  return {
    scheduled: i.scheduled, previousWork: i.previousWork, thisPeriodWork: e, storedNow: f, previousStored: i.previousStored,
    totalCompleted: g, pct: i.scheduled > 0 ? Math.round((g / i.scheduled) * 1e6) / 1e6 : null, balanceToFinish: i.scheduled - g,
    billedThisPeriod: e + f - i.previousStored,
  };
}

export interface G702Summary {
  originalContract: number;
  netChangeByCo: number;
  contractSumToDate: number;
  totalCompletedStored: number;
  retainageWork: number;
  retainageStored: number;
  retainageTotal: number;
  earnedLessRetainage: number;
  previousCertificates: number;
  currentPaymentDue: number;
  balanceToFinishInclRetainage: number;
}

/** pm.v_pay_application: the G702 face from the continuation lines. */
export function g702Summary(lines: ReadonlyArray<G703Line & { retainageWorkToDate: number; retainageStoredToDate: number }>,
  originalContract: number, previousCertificates: number): G702Summary {
  const sum = (f: (l: G703Line & { retainageWorkToDate: number; retainageStoredToDate: number }) => number) => lines.reduce((s, l) => s + f(l), 0);
  const contractSumToDate = sum((l) => l.scheduled);
  const totalCompletedStored = sum((l) => l.totalCompleted);
  const retainageWork = sum((l) => l.retainageWorkToDate);
  const retainageStored = sum((l) => l.retainageStoredToDate);
  const retainageTotal = retainageWork + retainageStored;
  const earnedLessRetainage = totalCompletedStored - retainageTotal;
  return {
    originalContract, netChangeByCo: contractSumToDate - originalContract, contractSumToDate, totalCompletedStored, retainageWork, retainageStored,
    retainageTotal, earnedLessRetainage, previousCertificates, currentPaymentDue: earnedLessRetainage - previousCertificates,
    balanceToFinishInclRetainage: contractSumToDate - earnedLessRetainage,
  };
}

// ------------------------------------------------------------------ change-order markups

export type MarkupKind = 'OHP' | 'OVERHEAD' | 'PROFIT' | 'FEE' | 'BOND' | 'INSURANCE' | 'LABOR_BURDEN' | 'OTHER';
export type CostType = 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER';

export interface MarkupRule {
  kind: MarkupKind;
  label?: string | null;
  appliesTo: 'ALL' | 'SELF_PERFORM' | 'SUBCONTRACT';
  costType: CostType | null;
  pct: number;
  compounding: boolean;
  tierMaxCents: number | null;
  minCents?: number | null;
  maxCents?: number | null;
  sort: number;
  isActive?: boolean;
}

export interface MarkupLine {
  costCents: number;
  costType: CostType | null;
  source: 'SELF' | 'SUB';
}

export interface MarkupResult {
  costCents: number;
  markupCents: number;
  amountCents: number;
  detail: Array<{ kind: MarkupKind; label: string; pct: number; baseCents: number; amountCents: number }>;
}

/** pm._cm_markup: families (kind × appliesTo × costType) in sort order; tiers by base; compounding on the running total. */
export function computeMarkup(rules: ReadonlyArray<MarkupRule>, lines: ReadonlyArray<MarkupLine>): MarkupResult {
  const active = rules.filter((r) => r.isActive !== false);
  const cost = lines.reduce((s, l) => s + l.costCents, 0);
  const famKey = (r: MarkupRule) => `${r.kind}|${r.appliesTo}|${r.costType ?? ''}`;
  const families = new Map<string, MarkupRule[]>();
  for (const r of active) {
    const k = famKey(r);
    const list = families.get(k) ?? [];
    list.push(r);
    families.set(k, list);
  }
  const ordered = [...families.values()].sort((a, b) => {
    const sa = Math.min(...a.map((r) => r.sort));
    const sb = Math.min(...b.map((r) => r.sort));
    if (sa !== sb) return sa - sb;
    const [ra, rb] = [a[0]!, b[0]!];
    return ra.kind.localeCompare(rb.kind) || ra.appliesTo.localeCompare(rb.appliesTo) || (ra.costType ?? '').localeCompare(rb.costType ?? '');
  });
  let running = cost;
  let markup = 0;
  const detail: MarkupResult['detail'] = [];
  for (const fam of ordered) {
    const f0 = fam[0]!;
    let base = lines
      .filter((l) => f0.appliesTo === 'ALL' || (f0.appliesTo === 'SUBCONTRACT' ? l.source === 'SUB' : l.source !== 'SUB'))
      .filter((l) => f0.costType === null || l.costType === f0.costType)
      .reduce((s, l) => s + l.costCents, 0);
    if (fam.some((r) => r.compounding)) base = running;
    const tier = [...fam]
      .filter((r) => r.tierMaxCents === null || r.tierMaxCents >= Math.abs(base))
      .sort((a, b) => (a.tierMaxCents ?? Number.MAX_SAFE_INTEGER) - (b.tierMaxCents ?? Number.MAX_SAFE_INTEGER) || a.sort - b.sort)[0];
    if (!tier || base === 0) continue;
    let amt = roundCents(base * tier.pct);
    if (tier.minCents != null && amt > 0 && amt < tier.minCents) amt = tier.minCents;
    if (tier.maxCents != null && amt > tier.maxCents) amt = tier.maxCents;
    markup += amt;
    running += amt;
    detail.push({ kind: tier.kind, label: tier.label ?? tier.kind, pct: tier.pct, baseCents: base, amountCents: amt });
  }
  return { costCents: cost, markupCents: markup, amountCents: cost + markup, detail };
}

// ------------------------------------------------------------------ WIP (CFMA)

export interface WipInput {
  contractCents: number;
  eacCents: number;
  costToDateCents: number;
  /** Uninstalled materials + inefficiency excluded from the cost-to-cost numerator. */
  excludedCents: number;
  billedCents: number;
  priorGpPct: number | null;
}

export interface WipRow {
  pctComplete: number;
  earnedCents: number;
  overBilledCents: number;
  underBilledCents: number;
  gpCents: number;
  gpPct: number | null;
  fadeGainPts: number | null;
  backlogCents: number;
  lossProvisionCents: number;
}

/** pm._cm_wip_rows (Projects computation). */
export function wipRow(i: WipInput): WipRow {
  const pct = i.eacCents > 0 ? Math.min(Math.max(i.costToDateCents - i.excludedCents, 0) / i.eacCents, 1) : 0;
  const earned = roundCents(i.contractCents * pct);
  const gp = i.contractCents - i.eacCents;
  const gpPct = i.contractCents > 0 ? Math.round((gp / i.contractCents) * 1e6) / 1e6 : null;
  return {
    pctComplete: Math.round(pct * 1e6) / 1e6,
    earnedCents: earned,
    overBilledCents: Math.max(i.billedCents - earned, 0),
    underBilledCents: Math.max(earned - i.billedCents, 0),
    gpCents: gp,
    gpPct,
    fadeGainPts: gpPct !== null && i.priorGpPct !== null ? Math.round((gpPct - i.priorGpPct) * 100 * 1e4) / 1e4 : null,
    backlogCents: Math.max(i.contractCents - earned, 0),
    lossProvisionCents: gp < 0 ? roundCents(-gp * (1 - pct)) : 0,
  };
}

// ------------------------------------------------------------------ over / under preview

/** Billing after this bill minus cost-to-cost earned (positive = billed ahead). Null when earned is not visible. */
export function overUnderAfter(billedToDate: number, thisBillGross: number, earned: number | null): number | null {
  return earned === null ? null : billedToDate + thisBillGross - earned;
}
