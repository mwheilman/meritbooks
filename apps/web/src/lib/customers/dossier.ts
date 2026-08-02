/**
 * Customer dossier — a deterministic payment-behavior + credit-risk profile
 * computed ENTIRELY in code from AR history. Every number here (days-to-pay,
 * utilization, revenue, risk flags) is derived by pure arithmetic; the AI model
 * is used ONLY to phrase a one-line risk summary from these already-computed
 * figures (see the dossier route), never to compute them. This is canon §3
 * applied to analytics: the machine does the accounting, the model narrates.
 *
 * All money is bigint cents. No I/O, no Date.now — callers pass `asOf` so the
 * profile is reproducible and unit-testable.
 */

export interface DossierInvoice {
  invoiceDate: string; // ISO date
  dueDate: string; // ISO date
  totalCents: number;
  balanceCents: number;
  status: string;
}

/** One payment application: when it was paid vs the invoice it settled. */
export interface DossierPayment {
  paymentDate: string; // ISO date (customer_payments.payment_date)
  invoiceDate: string; // ISO date of the settled invoice
  dueDate: string; // ISO date of the settled invoice
  amountCents: number;
}

export interface PaymentBehavior {
  paidApplicationCount: number;
  avgDaysToPay: number | null; // mean days from invoice_date → payment_date
  medianDaysToPay: number | null;
  worstDaysToPay: number | null; // slowest single payment
  lastDaysToPay: number | null; // most recent payment's days-to-pay
  lastPaymentDate: string | null;
  onTimeRate: number | null; // 0..1 — share of payments made by the due date
  avgDaysBeyondTerms: number | null; // mean lateness past the due date (0 if early)
  ttmRevenueCents: number; // trailing-12-month invoiced revenue
  openBalanceCents: number;
  overdueBalanceCents: number;
  overdueInvoiceCount: number;
  maxOverdueDays: number; // age of the oldest past-due open invoice
}

export interface CreditProfile {
  creditLimitCents: number | null; // null = no limit configured
  openArCents: number;
  /** open AR ÷ limit, 0..1+ ; null when no limit is set. */
  utilizationPct: number | null;
  /** limit − open AR ; null when no limit is set (can go negative = over-limit). */
  availableCreditCents: number | null;
}

export type RiskFlag = 'SLOW_PAY' | 'OVER_LIMIT' | 'APPROACHING_LIMIT' | 'DELINQUENT' | 'CONCENTRATION';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  flags: RiskFlag[];
  level: RiskLevel;
  /** deterministic, human-readable — also the fallback when the model is off. */
  summary: string;
}

export interface CustomerDossier {
  behavior: PaymentBehavior;
  credit: CreditProfile;
  risk: RiskAssessment;
  /** this customer's TTM revenue ÷ org TTM revenue, 0..1 ; null if org rev is 0. */
  concentrationPct: number | null;
}

// ── Tunable risk thresholds (single source of truth) ──────────────────────────
export const RISK_THRESHOLDS = {
  /** avg lateness (days past terms) at/above which a customer is a slow payer. */
  slowPayDaysBeyondTerms: 15,
  /** on-time rate below which a customer is a slow payer (min sample applies). */
  slowPayOnTimeRate: 0.6,
  /** minimum paid applications before pay-speed flags fire (avoid tiny samples). */
  minPaymentSample: 3,
  /** utilization at/above which the account is "approaching" its limit. */
  approachingUtilization: 0.9,
  /** open past-due age (days) at/above which the account is delinquent. */
  delinquentDays: 30,
  /** share of org TTM revenue at/above which the customer is a concentration risk. */
  concentrationShare: 0.25,
} as const;

// ── date helpers ──────────────────────────────────────────────────────────────
function daysBetween(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function withinTtm(dateIso: string, asOf: string): boolean {
  const d = new Date(dateIso).getTime();
  const end = new Date(asOf).getTime();
  if (Number.isNaN(d) || Number.isNaN(end)) return false;
  const start = end - 365 * 86_400_000;
  return d > start && d <= end;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

const OPEN_STATUSES = new Set(['SENT', 'PARTIALLY_PAID', 'OVERDUE']);

/**
 * Payment behavior from AR history. `termsDays` is the customer's net terms
 * (used for the on-time / beyond-terms measures). Pure.
 */
export function computePaymentBehavior(
  invoices: DossierInvoice[],
  payments: DossierPayment[],
  opts: { termsDays: number; asOf: string },
): PaymentBehavior {
  const { asOf } = opts;

  // ── pay-speed from settled applications ───────────────────────────────────
  const daysToPay: number[] = [];
  const beyondTerms: number[] = [];
  let onTime = 0;
  let last: { date: string; days: number } | null = null;

  for (const p of payments) {
    const dtp = daysBetween(p.invoiceDate, p.paymentDate);
    daysToPay.push(dtp);
    const lateness = Math.max(0, daysBetween(p.dueDate, p.paymentDate));
    beyondTerms.push(lateness);
    if (lateness === 0) onTime += 1;
    if (!last || new Date(p.paymentDate).getTime() >= new Date(last.date).getTime()) {
      last = { date: p.paymentDate, days: dtp };
    }
  }

  const n = daysToPay.length;
  const avg = n > 0 ? Math.round(daysToPay.reduce((s, d) => s + d, 0) / n) : null;
  const avgBeyond = n > 0 ? Math.round(beyondTerms.reduce((s, d) => s + d, 0) / n) : null;

  // ── open-AR + overdue picture ─────────────────────────────────────────────
  let ttmRevenueCents = 0;
  let openBalanceCents = 0;
  let overdueBalanceCents = 0;
  let overdueInvoiceCount = 0;
  let maxOverdueDays = 0;

  for (const inv of invoices) {
    if (inv.status !== 'VOIDED' && inv.status !== 'DRAFT' && withinTtm(inv.invoiceDate, asOf)) {
      ttmRevenueCents += inv.totalCents;
    }
    const isOpen = OPEN_STATUSES.has(inv.status) && inv.balanceCents > 0;
    if (!isOpen) continue;
    openBalanceCents += inv.balanceCents;
    const overdueDays = daysBetween(inv.dueDate, asOf);
    if (overdueDays > 0) {
      overdueBalanceCents += inv.balanceCents;
      overdueInvoiceCount += 1;
      if (overdueDays > maxOverdueDays) maxOverdueDays = overdueDays;
    }
  }

  return {
    paidApplicationCount: n,
    avgDaysToPay: avg,
    medianDaysToPay: median(daysToPay),
    worstDaysToPay: n > 0 ? Math.max(...daysToPay) : null,
    lastDaysToPay: last?.days ?? null,
    lastPaymentDate: last?.date ?? null,
    onTimeRate: n > 0 ? onTime / n : null,
    avgDaysBeyondTerms: avgBeyond,
    ttmRevenueCents,
    openBalanceCents,
    overdueBalanceCents,
    overdueInvoiceCount,
    maxOverdueDays,
  };
}

/** Credit utilization from the configured limit + current open AR. Pure. */
export function computeCreditProfile(input: {
  creditLimitCents: number | null;
  openArCents: number;
}): CreditProfile {
  const limit = input.creditLimitCents != null && input.creditLimitCents > 0 ? input.creditLimitCents : null;
  const openAr = Math.max(0, input.openArCents);
  return {
    creditLimitCents: limit,
    openArCents: openAr,
    utilizationPct: limit != null ? openAr / limit : null,
    availableCreditCents: limit != null ? limit - openAr : null,
  };
}

/** Risk flags + level + a deterministic one-line summary. Pure. */
export function computeRiskAssessment(
  customerName: string,
  behavior: PaymentBehavior,
  credit: CreditProfile,
  concentrationPct: number | null,
): RiskAssessment {
  const T = RISK_THRESHOLDS;
  const flags: RiskFlag[] = [];

  const enoughSample = behavior.paidApplicationCount >= T.minPaymentSample;
  const slowPay =
    enoughSample &&
    ((behavior.avgDaysBeyondTerms != null && behavior.avgDaysBeyondTerms >= T.slowPayDaysBeyondTerms) ||
      (behavior.onTimeRate != null && behavior.onTimeRate < T.slowPayOnTimeRate));
  if (slowPay) flags.push('SLOW_PAY');

  if (credit.availableCreditCents != null && credit.availableCreditCents < 0) {
    flags.push('OVER_LIMIT');
  } else if (credit.utilizationPct != null && credit.utilizationPct >= T.approachingUtilization) {
    flags.push('APPROACHING_LIMIT');
  }

  if (behavior.overdueBalanceCents > 0 && behavior.maxOverdueDays >= T.delinquentDays) {
    flags.push('DELINQUENT');
  }

  if (concentrationPct != null && concentrationPct >= T.concentrationShare) {
    flags.push('CONCENTRATION');
  }

  // Level: OVER_LIMIT or DELINQUENT is high; any single softer flag is medium.
  const hasHard = flags.includes('OVER_LIMIT') || flags.includes('DELINQUENT');
  const level: RiskLevel = hasHard ? 'high' : flags.length > 0 ? 'medium' : 'low';

  return { flags, level, summary: deterministicRiskSummary(customerName, behavior, credit, flags) };
}

/**
 * The deterministic risk sentence. This is BOTH the model's fallback and the
 * factual basis it is allowed to rephrase — the figures here are authored in
 * code, so the model never invents a number.
 */
export function deterministicRiskSummary(
  customerName: string,
  behavior: PaymentBehavior,
  credit: CreditProfile,
  flags: RiskFlag[],
): string {
  const name = customerName || 'This customer';
  if (flags.length === 0) {
    if (behavior.paidApplicationCount === 0) {
      return `${name} has no payment history yet — no risk signals, but the profile is thin.`;
    }
    const pace =
      behavior.avgDaysToPay != null ? `pays in ~${behavior.avgDaysToPay} days on average` : 'pays on schedule';
    return `${name} ${pace} with no open risk flags — a healthy account.`;
  }

  const parts: string[] = [];
  if (flags.includes('OVER_LIMIT') && credit.creditLimitCents != null) {
    const over = -(credit.availableCreditCents ?? 0);
    parts.push(`open AR exceeds its credit limit by ${dollars(over)}`);
  } else if (flags.includes('APPROACHING_LIMIT') && credit.utilizationPct != null) {
    parts.push(`credit utilization is ${(credit.utilizationPct * 100).toFixed(0)}%`);
  }
  if (flags.includes('DELINQUENT')) {
    parts.push(`${dollars(behavior.overdueBalanceCents)} is past due (oldest ${behavior.maxOverdueDays} days)`);
  }
  if (flags.includes('SLOW_PAY') && behavior.avgDaysBeyondTerms != null) {
    parts.push(`pays ~${behavior.avgDaysBeyondTerms} days beyond terms on average`);
  }
  if (flags.includes('CONCENTRATION')) {
    parts.push('represents a large share of total revenue (concentration risk)');
  }
  return `${name}: ${parts.join('; ')}.`;
}

function dollars(cents: number): string {
  return `$${(Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Assemble the full dossier from already-loaded rows. Pure — the route does the
 * I/O, this does the math, so the whole profile is unit-testable.
 */
export function buildDossier(input: {
  customerName: string;
  creditLimitCents: number | null;
  termsDays: number;
  invoices: DossierInvoice[];
  payments: DossierPayment[];
  orgTtmRevenueCents: number;
  asOf: string;
}): CustomerDossier {
  const behavior = computePaymentBehavior(input.invoices, input.payments, {
    termsDays: input.termsDays,
    asOf: input.asOf,
  });
  const credit = computeCreditProfile({
    creditLimitCents: input.creditLimitCents,
    openArCents: behavior.openBalanceCents,
  });
  const concentrationPct =
    input.orgTtmRevenueCents > 0 ? behavior.ttmRevenueCents / input.orgTtmRevenueCents : null;
  const risk = computeRiskAssessment(input.customerName, behavior, credit, concentrationPct);
  return { behavior, credit, risk, concentrationPct };
}
