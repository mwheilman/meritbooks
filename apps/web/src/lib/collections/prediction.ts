/**
 * Pay-date PREDICTION — a deterministic estimate of WHEN an open invoice will
 * actually be paid, from the customer's historical days-to-pay behavior plus the
 * invoice's own aging. PURE: no I/O, no Date.now — callers pass `asOf` so the
 * prediction is reproducible and unit-testable (Canon §3: the machine computes,
 * the model only narrates).
 *
 * The model:
 *   1. Baseline pace = the customer's MEDIAN days-to-pay when we have a real
 *      sample (robust to one-off outliers), else the mean, else net terms.
 *   2. predicted date = invoice date + baseline pace.
 *   3. If the invoice is ALREADY past that baseline and still open, the customer
 *      has blown their own norm — we "re-slip": push the prediction to
 *      asOf + a bounded fraction of how far past they already are.
 *   4. Confidence rises with sample size and consistency (tight spread, high
 *      on-time rate) and is capped to "medium" once a customer is behaving
 *      abnormally (already past their predicted pace).
 *
 * Every number here is authored in code; the AI never invents a date.
 */

const DAY_MS = 86_400_000;
/** Minimum settled payments before we trust the customer's own pace over terms. */
export const MIN_PREDICTION_SAMPLE = 3;

function parseMs(iso: string): number {
  return Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
}
function daysBetween(fromIso: string, toIso: string): number {
  const a = parseMs(fromIso);
  const b = parseMs(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / DAY_MS);
}
function addDays(iso: string, n: number): string {
  const base = parseMs(iso);
  if (Number.isNaN(base)) return iso.slice(0, 10);
  return new Date(base + n * DAY_MS).toISOString().slice(0, 10);
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** The historical pay-behavior signals a prediction consumes (from the dossier). */
export interface PayHistoryStats {
  /** Number of settled payment applications this customer has. */
  sampleSize: number;
  medianDaysToPay: number | null;
  avgDaysToPay: number | null;
  worstDaysToPay: number | null;
  /** Mean lateness past the due date across settled payments (0 = pays on time). */
  avgDaysBeyondTerms: number | null;
  /** Share of settled payments made by the due date, 0..1. */
  onTimeRate: number | null;
}

export type PredictionBasis = 'history_median' | 'history_avg' | 'terms_default';
export type PredictionConfidence = 'low' | 'medium' | 'high';

export interface PayPredictionInput {
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  asOf: string; // YYYY-MM-DD or ISO
  termsDays: number;
  history: PayHistoryStats;
}

export interface PayPrediction {
  /** Predicted actual pay date, YYYY-MM-DD. */
  predictedPayDate: string;
  /** Predicted days from invoice date to payment. */
  predictedDaysToPay: number;
  /** Predicted days late vs the due date (> 0 = expected to pay late). */
  predictedDaysLate: number;
  basis: PredictionBasis;
  confidence: PredictionConfidence;
  /** Confidence as a 0..1 score (the source of the bucket). */
  confidenceScore: number;
  /** True when `asOf` is already past the customer's typical pace and unpaid. */
  isOverdueBeyondPrediction: boolean;
  /** Deterministic one-liner — also the basis the model may rephrase. */
  rationale: string;
}

function sampleScore(n: number): number {
  if (n <= 0) return 0.15;
  if (n < 3) return 0.4;
  if (n < 6) return 0.65;
  if (n < 12) return 0.8;
  return 0.9;
}

/**
 * Predict the pay date for one open invoice. Returns null only when the invoice
 * or due date is unparseable. Pure & deterministic.
 */
export function predictPayDate(input: PayPredictionInput): PayPrediction | null {
  const { invoiceDate, dueDate, asOf, termsDays, history } = input;
  if (Number.isNaN(parseMs(invoiceDate)) || Number.isNaN(parseMs(dueDate))) return null;

  // 1. Baseline pace (days from invoice date to payment).
  let baselineDTP: number;
  let basis: PredictionBasis;
  if (history.sampleSize >= MIN_PREDICTION_SAMPLE && history.medianDaysToPay != null) {
    baselineDTP = history.medianDaysToPay;
    basis = 'history_median';
  } else if (history.sampleSize >= 1 && history.avgDaysToPay != null) {
    baselineDTP = history.avgDaysToPay;
    basis = 'history_avg';
  } else {
    baselineDTP = Math.max(0, termsDays);
    basis = 'terms_default';
  }
  baselineDTP = Math.max(0, Math.round(baselineDTP));

  const baseDate = addDays(invoiceDate, baselineDTP);

  // 2. Re-slip when already past the baseline and still open.
  const daysPastBaseline = daysBetween(baseDate, asOf);
  const isOverdueBeyondPrediction = daysPastBaseline > 0;
  const predictedPayDate = isOverdueBeyondPrediction
    ? addDays(asOf, clamp(Math.round(daysPastBaseline * 0.5) + 3, 3, 45))
    : baseDate;

  const predictedDaysToPay = daysBetween(invoiceDate, predictedPayDate);
  const predictedDaysLate = daysBetween(dueDate, predictedPayDate);

  // 3. Confidence: sample size, adjusted for consistency, capped when abnormal.
  let score = sampleScore(history.sampleSize);
  if (basis !== 'terms_default' && history.worstDaysToPay != null && history.medianDaysToPay != null) {
    const spread = history.worstDaysToPay - history.medianDaysToPay;
    const term = Math.max(termsDays, 1);
    if (spread <= term) score += 0.05;
    else if (spread > 3 * term) score -= 0.15;
  }
  if (history.onTimeRate != null) {
    if (history.onTimeRate >= 0.9) score += 0.05;
    else if (history.onTimeRate <= 0.3) score -= 0.05;
  }
  if (isOverdueBeyondPrediction) score = Math.min(score, 0.5);
  const confidenceScore = clamp(score, 0.05, 0.95);
  const confidence: PredictionConfidence =
    confidenceScore >= 0.7 ? 'high' : confidenceScore >= 0.45 ? 'medium' : 'low';

  // 4. Rationale.
  let rationale: string;
  if (basis === 'terms_default') {
    rationale = `No payment history yet — defaulting to ${Math.max(0, termsDays)}-day terms; expecting payment around ${predictedPayDate}.`;
  } else {
    const paceWord = basis === 'history_median' ? 'typically pays in' : 'has averaged';
    const lateBit =
      predictedDaysLate > 0
        ? `~${predictedDaysLate}d past due`
        : predictedDaysLate === 0
          ? 'right at the due date'
          : `${-predictedDaysLate}d before it's due`;
    rationale = isOverdueBeyondPrediction
      ? `Customer ${paceWord} ~${baselineDTP}d (n=${history.sampleSize}) but is already past that pace — projecting ${predictedPayDate}, ${lateBit}.`
      : `Customer ${paceWord} ~${baselineDTP}d (n=${history.sampleSize}) — projecting ${predictedPayDate}, ${lateBit}.`;
  }

  return {
    predictedPayDate,
    predictedDaysToPay,
    predictedDaysLate,
    basis,
    confidence,
    confidenceScore,
    isOverdueBeyondPrediction,
    rationale,
  };
}

/**
 * Expected value-at-risk (cents) for ranking: overdue dollars weighted by how late
 * the money is expected to be. Uses the prediction's forecast lateness when we
 * have one, else the invoice's current age as the lateness proxy. Bounded so one
 * ancient invoice can't dominate the whole book. Pure.
 */
export function computeExpectedValueAtRisk(input: {
  overdueBalanceCents: number;
  predictedDaysLate: number | null;
  maxDaysOverdue: number;
}): number {
  const lateness =
    input.predictedDaysLate != null && input.predictedDaysLate > input.maxDaysOverdue
      ? input.predictedDaysLate
      : input.maxDaysOverdue;
  const latenessFactor = 1 + Math.min(Math.max(lateness, 0), 120) / 30;
  return Math.round(Math.max(0, input.overdueBalanceCents) * latenessFactor);
}
