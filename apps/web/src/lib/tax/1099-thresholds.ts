/**
 * 1099 FILING THRESHOLDS BY TAX YEAR — the single source of truth for every
 * "paid at least $X" test in the 1099 path (readiness, NEC/MISC assembly, the
 * FIRE/IRIS file batches built from them, the W9_1099_GAP chase detector, the
 * vendor 360 and the UI copy).
 *
 * Owner decision (binding): thresholds follow whatever the law is for the tax year.
 * Never hardcode $600 anywhere else; ask this module.
 *
 * THE LAW (as of 2026-10):
 *  - Pre-OBBBA (payments made through 2025): Form 1099-NEC and most Form 1099-MISC
 *    boxes are due at $600 or more (IRC 6041(a) / 6041A(a)).
 *  - P.L. 119-21 ("One Big Beautiful Bill Act", 2025) sec. 70433 raised that floor
 *    to $2,000 for payments made after 2025 (tax year 2026), indexed for inflation
 *    starting in calendar year 2027 (2025 base, rounded to a multiple of $100).
 *    Backup withholding (IRC 3406(b)(6)) moves with the same floor.
 *    Confirmed in the IRS 2026 Instructions for Forms 1099-MISC and 1099-NEC
 *    ("increased to $2,000 and may be adjusted for inflation beginning in calendar
 *    year 2027").
 *  - NOT changed by OBBBA (separate Code sections), per those same instructions:
 *      MISC box 2 royalties ............................. $10   (IRC 6050N)
 *      MISC box 8 substitute payments in lieu of div/int  $10
 *      MISC box 10 gross proceeds paid to an attorney ... $600  (IRC 6045(f))
 *      MISC box 7 / NEC box 2 direct sales of consumer
 *        products for resale (checkbox) ................. $5,000
 *  - Form 1099-K (third-party settlement organizations): OBBBA (P.L. 119-21)
 *    retroactively restored the pre-ARPA test — gross payments EXCEED $20,000 AND
 *    the number of transactions EXCEEDS 200 (IRC 6050W(e)). Card / TPSO spend is
 *    the processor's 1099-K, which is why readiness excludes card rails.
 *
 * 2027 AND LATER: the IRS publishes the indexed amount each year. Until it does,
 * this module returns the most recent known amount ($2,000 for 2027 if nothing is
 * published) and flags the result `provisional: true` with a notice the UI shows.
 * That is deliberately conservative: indexing can only raise the floor, so using
 * the prior amount can only surface MORE candidates for CPA review, never silently
 * drop a reportable vendor. It NEVER falls back to $600 for 2026+.
 *
 * PURITY: no I/O, no clock (callers pass the tax year). Safe to import from both
 * server routes and client components.
 */

// ── The one table to update when the IRS publishes an indexed amount ────────────

/**
 * TODO(irs-indexing): when the IRS publishes the inflation-adjusted 1099-NEC /
 * 1099-MISC general threshold for a calendar year (Rev. Proc. or the year's
 * Instructions for Forms 1099-MISC and 1099-NEC), add it here as integer cents,
 * e.g. `2027: 210_000`. Nothing else in the codebase needs to change. Years with
 * no entry are treated as PROVISIONAL (prior published amount, flagged in the UI).
 */
export const IRS_INDEXED_GENERAL_THRESHOLD_CENTS: Readonly<Record<number, number>> = Object.freeze({
  // 2027: <publish>,
});

/** Last calendar year of the pre-OBBBA $600 regime. */
export const PRE_OBBBA_LAST_YEAR = 2025;
/** First calendar year of the OBBBA $2,000 regime. */
export const OBBBA_FIRST_YEAR = 2026;
/** First calendar year in which the OBBBA amount may be inflation-indexed. */
export const OBBBA_INDEXING_FIRST_YEAR = 2027;

const PRE_OBBBA_GENERAL_CENTS = 60_000; // $600
const OBBBA_BASE_GENERAL_CENTS = 200_000; // $2,000
const ROYALTY_CENTS = 1_000; // $10 — IRC 6050N, unchanged by OBBBA
const SUBSTITUTE_PAYMENT_CENTS = 1_000; // $10 — MISC box 8, unchanged
const ATTORNEY_GROSS_PROCEEDS_CENTS = 60_000; // $600 — IRC 6045(f), unchanged by OBBBA
const DIRECT_SALES_CENTS = 500_000; // $5,000 — MISC box 7 / NEC box 2 checkbox
const FORM_1099K_GROSS_EXCEEDS_CENTS = 2_000_000; // > $20,000
const FORM_1099K_TRANSACTIONS_EXCEED = 200; // > 200 transactions

/** Supported tax-year range (guards obviously bad input such as 0 or 20260). */
export const MIN_TAX_YEAR = 1990;
export const MAX_TAX_YEAR = 2200;

// ── Types ────────────────────────────────────────────────────────────────────────

export type Ten99Regime = 'PRE_OBBBA' | 'OBBBA' | 'OBBBA_INDEXED';

/**
 * 1099-MISC boxes that carry a dollar floor. Keys mirror box-classify's
 * `<FORM>_<BOX>` codes so callers can index directly with a MiscBoxCode.
 */
export type MiscThresholdBox =
  | 'MISC_1' // rents
  | 'MISC_2' // royalties
  | 'MISC_3' // other income / prizes / awards
  | 'MISC_6' // medical and health care payments
  | 'MISC_8' // substitute payments in lieu of dividends or interest
  | 'MISC_9' // crop insurance proceeds
  | 'MISC_10'; // gross proceeds paid to an attorney

export const MISC_THRESHOLD_BOXES: readonly MiscThresholdBox[] = [
  'MISC_1',
  'MISC_2',
  'MISC_3',
  'MISC_6',
  'MISC_8',
  'MISC_9',
  'MISC_10',
];

export interface Form1099KThreshold {
  /** Gross reportable payments must EXCEED this many cents ... */
  grossExceedsCents: number;
  /** ... AND the transaction count must EXCEED this number. */
  transactionsExceed: number;
}

export interface Ten99Thresholds {
  taxYear: number;
  regime: Ten99Regime;
  /** The general 6041/6041A floor that OBBBA changed (cents, "at least"). */
  generalCents: number;
  /** 1099-NEC box 1 nonemployee compensation floor (cents, "at least"). */
  necCents: number;
  /** Per-box 1099-MISC floor (cents, "at least"). */
  miscBoxCents: Readonly<Record<MiscThresholdBox, number>>;
  /** MISC box 7 / NEC box 2 direct-sales checkbox floor (cents, "totaling at least"). */
  directSalesCents: number;
  /** Backup withholding applies to reportable payments once this floor is met (cents). */
  backupWithholdingCents: number;
  form1099K: Form1099KThreshold;
  /**
   * True when the year is 2027+ and the IRS-published indexed amount has not been
   * entered in IRS_INDEXED_GENERAL_THRESHOLD_CENTS. The amounts are then the most
   * recent known figures and the UI must show `notice`.
   */
  provisional: boolean;
  /** Human-readable caveat for provisional years; null otherwise. */
  notice: string | null;
  /** Short legal authority string for audit trails / tooltips. */
  authority: string;
}

// ── Core lookup ──────────────────────────────────────────────────────────────────

function assertTaxYear(taxYear: number): void {
  if (!Number.isInteger(taxYear) || taxYear < MIN_TAX_YEAR || taxYear > MAX_TAX_YEAR) {
    throw new RangeError(`Invalid 1099 tax year: ${String(taxYear)}`);
  }
}

/**
 * Resolve the general (6041/6041A) floor for a year.
 * ≤2025 → $600 · 2026 → $2,000 · 2027+ → IRS-published indexed amount, else the
 * most recent published/known amount flagged provisional.
 */
function resolveGeneral(taxYear: number): {
  cents: number;
  regime: Ten99Regime;
  provisional: boolean;
  basisYear: number;
} {
  if (taxYear <= PRE_OBBBA_LAST_YEAR) {
    return { cents: PRE_OBBBA_GENERAL_CENTS, regime: 'PRE_OBBBA', provisional: false, basisYear: taxYear };
  }
  if (taxYear < OBBBA_INDEXING_FIRST_YEAR) {
    return { cents: OBBBA_BASE_GENERAL_CENTS, regime: 'OBBBA', provisional: false, basisYear: taxYear };
  }
  const published = IRS_INDEXED_GENERAL_THRESHOLD_CENTS[taxYear];
  if (typeof published === 'number' && Number.isInteger(published) && published > 0) {
    return { cents: published, regime: 'OBBBA_INDEXED', provisional: false, basisYear: taxYear };
  }
  // Not yet published: walk back to the most recent published year, else the 2026 base.
  for (let y = taxYear - 1; y >= OBBBA_INDEXING_FIRST_YEAR; y--) {
    const prior = IRS_INDEXED_GENERAL_THRESHOLD_CENTS[y];
    if (typeof prior === 'number' && Number.isInteger(prior) && prior > 0) {
      return { cents: prior, regime: 'OBBBA_INDEXED', provisional: true, basisYear: y };
    }
  }
  return { cents: OBBBA_BASE_GENERAL_CENTS, regime: 'OBBBA_INDEXED', provisional: true, basisYear: OBBBA_FIRST_YEAR };
}

/** Every 1099 dollar floor that applies to payments made in `taxYear`. */
export function get1099Thresholds(taxYear: number): Ten99Thresholds {
  assertTaxYear(taxYear);
  const g = resolveGeneral(taxYear);
  const general = g.cents;

  const miscBoxCents: Record<MiscThresholdBox, number> = {
    MISC_1: general,
    MISC_2: ROYALTY_CENTS,
    MISC_3: general,
    MISC_6: general,
    MISC_8: SUBSTITUTE_PAYMENT_CENTS,
    MISC_9: general,
    MISC_10: ATTORNEY_GROSS_PROCEEDS_CENTS,
  };

  const authority =
    g.regime === 'PRE_OBBBA'
      ? 'IRC 6041/6041A ($600, payments through 2025)'
      : g.regime === 'OBBBA'
        ? 'P.L. 119-21 sec. 70433 ($2,000, payments made in 2026)'
        : `P.L. 119-21 sec. 70433, inflation-indexed for ${taxYear}`;

  const notice = g.provisional
    ? `The IRS has not yet published the inflation-adjusted ${taxYear} 1099 threshold in MeritBooks. ` +
      `Using ${formatThresholdUsd(general)} (the ${g.basisYear} amount) provisionally — indexing can only raise it, ` +
      `so this may list extra candidates for review but will not miss one.`
    : null;

  return Object.freeze({
    taxYear,
    regime: g.regime,
    generalCents: general,
    necCents: general,
    miscBoxCents: Object.freeze(miscBoxCents),
    directSalesCents: DIRECT_SALES_CENTS,
    backupWithholdingCents: general,
    form1099K: Object.freeze({
      grossExceedsCents: FORM_1099K_GROSS_EXCEEDS_CENTS,
      transactionsExceed: FORM_1099K_TRANSACTIONS_EXCEED,
    }),
    provisional: g.provisional,
    notice,
    authority,
  });
}

// ── Convenience helpers ──────────────────────────────────────────────────────────

/** 1099-NEC box 1 floor for the year (cents, "at least"). */
export function necThresholdCents(taxYear: number): number {
  return get1099Thresholds(taxYear).necCents;
}

/** 1099-MISC floor for one box in the year (cents, "at least"). */
export function miscBoxThresholdCents(taxYear: number, box: MiscThresholdBox): number {
  return get1099Thresholds(taxYear).miscBoxCents[box];
}

/** True when a NEC box-1 amount is reportable for the year. */
export function meetsNecThreshold(taxYear: number, cents: number): boolean {
  return Math.trunc(Number(cents) || 0) >= necThresholdCents(taxYear);
}

/**
 * True when a TPSO / card processor must issue a 1099-K: gross EXCEEDS $20,000
 * AND transactions EXCEED 200 (OBBBA restored test; applies to every year).
 */
export function meets1099KThreshold(taxYear: number, grossCents: number, transactionCount: number): boolean {
  const k = get1099Thresholds(taxYear).form1099K;
  return Math.trunc(Number(grossCents) || 0) > k.grossExceedsCents && Math.trunc(Number(transactionCount) || 0) > k.transactionsExceed;
}

/**
 * Integer cents → "$2,000" / "$10" / "$600.50". Integer arithmetic only. Used for
 * UI copy and reasons so the dollar figure in text always matches the rule.
 */
export function formatThresholdUsd(cents: number): string {
  const n = Math.max(0, Math.trunc(Number(cents) || 0));
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === 0 ? `$${wholeStr}` : `$${wholeStr}.${String(frac).padStart(2, '0')}`;
}
