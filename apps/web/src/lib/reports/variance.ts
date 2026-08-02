/**
 * Deterministic flux / variance computer (M7 — Narrative & Explanation).
 *
 * This is the CORRECTNESS GUARANTEE for the AI flux narrative: EVERY figure the
 * board narrative can cite is computed HERE, in code, from the two periods'
 * report line items. The model is only ever handed these already-computed
 * drivers and asked to PHRASE them — it never recomputes, invents, or reconciles
 * a number. Pure and side-effect free (numbers in → ranked drivers out) so it is
 * exhaustively unit-testable.
 *
 * All money is bigint cents. Percentages are the only derived float and are
 * `null` (not zero, not Infinity) when the prior base is zero, so the narrative
 * layer can say "new this period" rather than fabricate a percentage.
 */

export type Direction = 'up' | 'down' | 'flat';

/** One report line, already resolved to a signed presentation amount (cents). */
export interface VarianceLine {
  /** Stable identifier across periods (e.g. account number). */
  key: string;
  /** Human label (e.g. account name). */
  label: string;
  /** Section bucket: REVENUE | COGS | OPEX | OTHER (P&L) or ASSET | LIABILITY | EQUITY (BS). */
  section: string;
  /** Signed amount for the line in this period, in cents. */
  amountCents: number;
}

export interface VarianceDriver {
  key: string;
  line: string;
  section: string;
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  /** Percent change vs the prior base; null when prior is 0 (not computable). */
  pct: number | null;
  direction: Direction;
  /** true = favorable, false = unfavorable, null = neutral (e.g. balance-sheet lines). */
  favorable: boolean | null;
}

export interface SectionTotal {
  section: string;
  currentCents: number;
  priorCents: number;
  deltaCents: number;
}

export interface VarianceResult {
  /** Top movers, ranked by absolute dollar delta (largest first). */
  drivers: VarianceDriver[];
  sectionTotals: SectionTotal[];
  /** Net income (P&L) for each period, or null for a neutral/balance report. */
  netCurrentCents: number | null;
  netPriorCents: number | null;
  netDeltaCents: number | null;
}

export interface ComputeVarianceOptions {
  /** How many ranked drivers to return. Default 8. */
  topN?: number;
  /** Favorability model. 'pnl' = revenue-up-good / cost-up-bad; 'neutral' = no favorability. */
  mode?: 'pnl' | 'neutral';
  /** Sections treated as revenue for favorability + net income. Default ['REVENUE']. */
  revenueSections?: string[];
  /** Sections treated as cost for favorability + net income. Default ['COGS','OPEX','OTHER']. */
  costSections?: string[];
}

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Percent change of `current` vs `prior`; null when the base is zero. */
export function pctChange(currentCents: number, priorCents: number): number | null {
  if (priorCents === 0) return null;
  return roundPct((currentCents - priorCents) / Math.abs(priorCents) * 100);
}

function directionOf(deltaCents: number): Direction {
  if (deltaCents > 0) return 'up';
  if (deltaCents < 0) return 'down';
  return 'flat';
}

/**
 * Compute ranked flux drivers between a current and a prior period.
 *
 * The two inputs are the SAME report rendered for two periods; lines are matched
 * by `key`. A line present in only one period is treated as 0 in the other, so
 * brand-new or fully-eliminated lines surface as drivers (with pct = null).
 */
export function computeVariances(
  current: VarianceLine[],
  prior: VarianceLine[],
  options: ComputeVarianceOptions = {},
): VarianceResult {
  const topN = options.topN ?? 8;
  const mode = options.mode ?? 'pnl';
  const revenueSections = options.revenueSections ?? ['REVENUE'];
  const costSections = options.costSections ?? ['COGS', 'OPEX', 'OTHER'];

  const curMap = new Map<string, VarianceLine>();
  for (const l of current) curMap.set(l.key, l);
  const priMap = new Map<string, VarianceLine>();
  for (const l of prior) priMap.set(l.key, l);

  const favorabilityOf = (section: string, deltaCents: number): boolean | null => {
    if (mode === 'neutral' || deltaCents === 0) return null;
    if (revenueSections.includes(section)) return deltaCents > 0;
    if (costSections.includes(section)) return deltaCents < 0;
    return null;
  };

  // Union of keys across both periods.
  const keys = new Set<string>([...curMap.keys(), ...priMap.keys()]);
  const drivers: VarianceDriver[] = [];

  for (const key of keys) {
    const cur = curMap.get(key);
    const pri = priMap.get(key);
    const currentCents = cur?.amountCents ?? 0;
    const priorCents = pri?.amountCents ?? 0;
    const deltaCents = currentCents - priorCents;
    if (deltaCents === 0) continue; // no movement → not a driver
    const section = cur?.section ?? pri?.section ?? '';
    drivers.push({
      key,
      line: cur?.label ?? pri?.label ?? key,
      section,
      currentCents,
      priorCents,
      deltaCents,
      pct: pctChange(currentCents, priorCents),
      direction: directionOf(deltaCents),
      favorable: favorabilityOf(section, deltaCents),
    });
  }

  // Rank by absolute dollar movement; deterministic tiebreak by |current| then key.
  drivers.sort((a, b) => {
    const d = Math.abs(b.deltaCents) - Math.abs(a.deltaCents);
    if (d !== 0) return d;
    const c = Math.abs(b.currentCents) - Math.abs(a.currentCents);
    if (c !== 0) return c;
    return a.key.localeCompare(b.key);
  });

  // Section totals across the union of sections seen.
  const sectionKeys = new Set<string>();
  for (const l of current) sectionKeys.add(l.section);
  for (const l of prior) sectionKeys.add(l.section);
  const sectionTotals: SectionTotal[] = [];
  const sumSection = (lines: VarianceLine[], section: string) =>
    lines.filter((l) => l.section === section).reduce((s, l) => s + l.amountCents, 0);
  for (const section of sectionKeys) {
    const c = sumSection(current, section);
    const p = sumSection(prior, section);
    sectionTotals.push({ section, currentCents: c, priorCents: p, deltaCents: c - p });
  }

  // Net income (P&L only): revenue sections − cost sections.
  let netCurrentCents: number | null = null;
  let netPriorCents: number | null = null;
  let netDeltaCents: number | null = null;
  if (mode === 'pnl') {
    const netOf = (lines: VarianceLine[]) => {
      let net = 0;
      for (const l of lines) {
        if (revenueSections.includes(l.section)) net += l.amountCents;
        else if (costSections.includes(l.section)) net -= l.amountCents;
      }
      return net;
    };
    netCurrentCents = netOf(current);
    netPriorCents = netOf(prior);
    netDeltaCents = netCurrentCents - netPriorCents;
  }

  return {
    drivers: drivers.slice(0, topN),
    sectionTotals,
    netCurrentCents,
    netPriorCents,
    netDeltaCents,
  };
}
