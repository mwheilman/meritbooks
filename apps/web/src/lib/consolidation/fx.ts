/**
 * Foreign-currency translation for consolidation (GATE 11a — multi-currency).
 *
 * PURE, deterministic, side-effect free — same inputs always yield the same output,
 * so it is unit-tested hard alongside the consolidation engine. It translates ONE
 * entity's trial balance from that entity's FUNCTIONAL currency into the group's
 * REPORTING currency using the current-rate method:
 *
 *   • REVENUE / COGS / OPEX / OTHER (the P&L) → AVERAGE rate for the period.
 *   • ASSET / LIABILITY (monetary balance-sheet items) → CLOSING (period-end) rate.
 *   • EQUITY (contributed capital / retained earnings) → HISTORICAL rate.
 *
 * Because the three bases differ, a translated balance sheet no longer ties on its
 * own. The residual is the Cumulative Translation Adjustment (CTA) — a plug booked
 * to equity / OCI so the translated statement balances exactly:
 *
 *     assets = liabilities + equity + net income + CTA
 *   ⇒ CTA   = assets − liabilities − equity − net income        (all translated)
 *
 * The CTA is emitted as a synthetic EQUITY line, so when the translated balances
 * flow into the consolidation engine the equity section absorbs it and the
 * consolidated balance-check stays exactly 0. All money is bigint cents; rates are
 * `number` (numeric in the DB). Rounding happens once per line (Math.round, matching
 * the engine), and the CTA is derived from the ALREADY-ROUNDED totals, so it absorbs
 * every rounding penny and the translated books tie to the cent.
 *
 * SINGLE-CURRENCY IDENTITY: when an entity's functional currency EQUALS the reporting
 * currency the balances pass through UNCHANGED (no rate applied, no CTA line) — so a
 * single-currency tenant's consolidation is byte-for-byte what it was pre-FX.
 */

import type { AccountType, EntityAccountBalance } from './consolidate';

export type RateType = 'SPOT' | 'AVERAGE' | 'CLOSING';

/** A raw FX rate row (mirrors public.fx_rates, migration 089). */
export interface FxRateRow {
  fromCurrency: string;
  toCurrency: string;
  rateDate: string; // YYYY-MM-DD
  rate: number; // units of toCurrency per 1 unit of fromCurrency
  rateType: RateType;
}

/** The three translation bases (functional → reporting), each a plain multiplier. */
export interface TranslationRates {
  /** P&L flows (REVENUE / COGS / OPEX / OTHER). */
  average: number;
  /** Monetary balance-sheet items (ASSET / LIABILITY). */
  closing: number;
  /** Equity (contributed capital / retained earnings). */
  historical: number;
}

export const IDENTITY_RATES: TranslationRates = { average: 1, closing: 1, historical: 1 };

/** Synthetic account the CTA plug is emitted under (not a real GL account). */
export const CTA_ACCOUNT_NUMBER = 'CTA';
export const CTA_ACCOUNT_NAME = 'Cumulative translation adjustment';

const PNL_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['REVENUE', 'COGS', 'OPEX', 'OTHER']);

/** Which translation basis applies to a given account type. */
export function rateForType(type: AccountType, rates: TranslationRates): number {
  if (PNL_TYPES.has(type)) return rates.average;
  if (type === 'EQUITY') return rates.historical;
  return rates.closing; // ASSET, LIABILITY
}

export interface TranslateOptions {
  functionalCurrency: string;
  reportingCurrency: string;
  rates: TranslationRates;
  /** Override the synthetic CTA account number / name (defaults to the constants). */
  ctaAccountNumber?: string;
  ctaAccountName?: string;
}

export interface TranslationResult {
  entityId: string | null;
  /** Translated balances in the reporting currency; includes the CTA line when ≠ 0. */
  translated: EntityAccountBalance[];
  /** The CTA plug in reporting-currency cents (credit-normal, i.e. equity-positive). */
  ctaCents: number;
  functionalCurrency: string;
  reportingCurrency: string;
  rates: TranslationRates;
  /** True when a real translation happened (functional ≠ reporting). */
  translated_applied: boolean;
}

/**
 * Translate ONE entity's trial balance (all lines must share the same entityId)
 * from its functional currency into the reporting currency, appending a CTA plug so
 * the translated balance sheet ties. Degrades to an exact pass-through when the two
 * currencies match (single-currency identity).
 */
export function translateEntityTB(
  balances: EntityAccountBalance[],
  opts: TranslateOptions,
): TranslationResult {
  const entityId = balances[0]?.entityId ?? null;
  const same = opts.functionalCurrency === opts.reportingCurrency;

  if (same || balances.length === 0) {
    return {
      entityId,
      translated: balances.map((b) => ({ ...b })),
      ctaCents: 0,
      functionalCurrency: opts.functionalCurrency,
      reportingCurrency: opts.reportingCurrency,
      rates: IDENTITY_RATES,
      translated_applied: false,
    };
  }

  const translated: EntityAccountBalance[] = balances.map((b) => ({
    ...b,
    naturalBalanceCents: Math.round(b.naturalBalanceCents * rateForType(b.accountType, opts.rates)),
  }));

  // Translated subtotals, natural-sign, to derive the CTA plug.
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  let revenue = 0;
  let expense = 0;
  for (const b of translated) {
    switch (b.accountType) {
      case 'ASSET':
        assets += b.naturalBalanceCents;
        break;
      case 'LIABILITY':
        liabilities += b.naturalBalanceCents;
        break;
      case 'EQUITY':
        equity += b.naturalBalanceCents;
        break;
      case 'REVENUE':
        revenue += b.naturalBalanceCents;
        break;
      case 'COGS':
      case 'OPEX':
      case 'OTHER':
        expense += b.naturalBalanceCents;
        break;
    }
  }
  const netIncome = revenue - expense;
  // assets = liabilities + equity + netIncome + CTA  ⇒  CTA is the plug.
  const ctaCents = assets - liabilities - equity - netIncome;

  if (ctaCents !== 0 && entityId) {
    translated.push({
      entityId,
      accountNumber: opts.ctaAccountNumber ?? CTA_ACCOUNT_NUMBER,
      accountName: opts.ctaAccountName ?? CTA_ACCOUNT_NAME,
      accountType: 'EQUITY',
      isEliminating: false,
      role: null,
      naturalBalanceCents: ctaCents,
    });
  }

  return {
    entityId,
    translated,
    ctaCents,
    functionalCurrency: opts.functionalCurrency,
    reportingCurrency: opts.reportingCurrency,
    rates: opts.rates,
    translated_applied: true,
  };
}

export interface ResolvedRates {
  rates: TranslationRates;
  /** Which bases were backed by a real rate row (vs a fallback). */
  resolved: { average: boolean; closing: boolean; historical: boolean };
}

/**
 * Resolve the three translation bases for a currency pair from a set of FX rows.
 * Deterministic selection:
 *   • closing    = most-recent CLOSING (else most-recent SPOT, else AVERAGE).
 *   • average    = most-recent AVERAGE (else the closing rate).
 *   • historical = EARLIEST known rate for the pair (a proxy for when equity was
 *                  contributed), else the closing rate.
 * With no rows for the pair, all three fall back to 1.0. Identity pair (from == to)
 * short-circuits to IDENTITY_RATES.
 */
export function resolveTranslationRates(
  rows: FxRateRow[],
  fromCurrency: string,
  toCurrency: string,
): ResolvedRates {
  if (fromCurrency === toCurrency) {
    return { rates: { ...IDENTITY_RATES }, resolved: { average: true, closing: true, historical: true } };
  }
  const relevant = rows.filter((r) => r.fromCurrency === fromCurrency && r.toCurrency === toCurrency);

  const latestOfType = (t: RateType): number | null => {
    let best: FxRateRow | null = null;
    for (const r of relevant) {
      if (r.rateType !== t) continue;
      if (!best || r.rateDate > best.rateDate) best = r;
    }
    return best ? best.rate : null;
  };
  const earliestOfAny = (): number | null => {
    let best: FxRateRow | null = null;
    for (const r of relevant) {
      if (!best || r.rateDate < best.rateDate) best = r;
    }
    return best ? best.rate : null;
  };

  const closingRaw = latestOfType('CLOSING') ?? latestOfType('SPOT') ?? latestOfType('AVERAGE');
  const averageRaw = latestOfType('AVERAGE');
  const historicalRaw = earliestOfAny();

  const closing = closingRaw ?? 1;
  const average = averageRaw ?? closing;
  const historical = historicalRaw ?? closing;

  return {
    rates: { average, closing, historical },
    resolved: {
      average: averageRaw != null,
      closing: closingRaw != null,
      historical: historicalRaw != null,
    },
  };
}
