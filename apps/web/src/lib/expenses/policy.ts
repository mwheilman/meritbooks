/**
 * Deterministic out-of-policy detector for employee expense-report lines.
 *
 * PURE and side-effect-free — no I/O, no clock, no randomness — so it is fully
 * unit-testable and produces identical flags for identical input. It NEVER blocks
 * the ledger; it only annotates lines with reasons a human reviewer should see
 * (canon: AI/heuristics propose FACTS, a human approves). The reimbursement post
 * happens regardless of flags — flags exist to inform the approver.
 *
 * Rules implemented:
 *   OVER_CATEGORY_LIMIT — line amount exceeds the per-category cap.
 *   MISSING_RECEIPT     — no receipt attached and amount ≥ the receipt threshold.
 *   OVER_MAX            — line amount exceeds the absolute per-expense ceiling.
 *   WEEKEND_EXPENSE     — expense dated on a Saturday/Sunday (informational).
 *   DUPLICATE           — same merchant + amount + date appears more than once.
 *   PERSONAL_ON_CARD    — a personal-category expense charged to the corporate card.
 *
 * UPGRADE (Session 44 — policy compiler): the POLICY-DRIVEN checks (category
 * limits, receipt threshold, prohibited/pre-approval, per-diem, alcohol/
 * entertainment caps, amount-tiered approval routing) now come from the ACTIVE
 * compiled ruleset via the deterministic engine (`policy-engine.ts`). This file's
 * legacy `evaluateExpensePolicy(config)` remains for back-compat, but the live
 * flow calls `evaluateLinesWithRuleset()` below, which DELEGATES to the engine and
 * folds in the two always-on, policy-independent heuristics (DUPLICATE, WEEKEND).
 */

import { evaluateReport, type EngineLine } from './policy-engine';
import type {
  ExpensePolicyRuleset,
  RuleSeverity as EngineRuleSeverity,
} from './policy-schema';

export type PolicyFlagCode =
  | 'OVER_CATEGORY_LIMIT'
  | 'MISSING_RECEIPT'
  | 'OVER_MAX'
  | 'WEEKEND_EXPENSE'
  | 'DUPLICATE'
  | 'PERSONAL_ON_CARD'
  // Ruleset-engine rule ids (stored verbatim so the UI can cite the rule).
  | 'CATEGORY_PROHIBITED'
  | 'PREAPPROVAL_REQUIRED'
  | 'CATEGORY_PER_EXPENSE_LIMIT'
  | 'CATEGORY_PER_DAY_LIMIT'
  | 'CATEGORY_PER_TRIP_LIMIT'
  | 'ABSOLUTE_CEILING'
  | 'RECEIPT_REQUIRED'
  | 'ALCOHOL_CAP'
  | 'ENTERTAINMENT_CAP'
  | 'PER_DIEM_EXCEEDED';

export type PolicySeverity = 'info' | 'warn' | 'block';

export interface PolicyFlag {
  code: PolicyFlagCode;
  /** Human-readable, deterministic message (no dates/timestamps of "now"). */
  message: string;
  severity: PolicySeverity;
}

export type PaymentSource = 'OUT_OF_POCKET' | 'CORPORATE_CARD';

/** One line as the detector sees it — the caller maps DB rows onto this shape. */
export interface PolicyLineInput {
  /** Stable id used to key the result back to the source row. */
  id: string;
  /** ISO date (YYYY-MM-DD). Only the calendar date is used. */
  expenseDate: string;
  merchant: string | null;
  /** Category key — the GL account id (or any stable category token). */
  categoryKey: string | null;
  amountCents: number;
  hasReceipt: boolean;
  paymentSource: PaymentSource;
}

export interface ExpensePolicyConfig {
  /** Per-category (by categoryKey) hard cap in cents. Missing key = no cap. */
  categoryLimitsCents: Record<string, number>;
  /** Receipt required at or above this amount (cents). */
  receiptRequiredOverCents: number;
  /** Absolute per-expense ceiling (cents). 0/undefined disables. */
  perExpenseMaxCents?: number;
  /** Category keys that may NOT be charged to a corporate card. */
  personalCategoryKeys?: string[];
  /** Flag weekend-dated expenses (informational). Default true. */
  flagWeekend?: boolean;
}

export interface PolicyLineResult {
  lineId: string;
  flags: PolicyFlag[];
  /** True when any flag is present. */
  flagged: boolean;
}

export interface PolicyResult {
  lines: PolicyLineResult[];
  /** Count of lines carrying at least one flag. */
  flaggedCount: number;
}

/**
 * Sensible defaults for a mid-market services firm. All amounts in cents.
 * The caller can override any field per-tenant.
 */
export const DEFAULT_EXPENSE_POLICY: ExpensePolicyConfig = {
  categoryLimitsCents: {},
  receiptRequiredOverCents: 7500, // $75
  perExpenseMaxCents: 500000, // $5,000
  personalCategoryKeys: [],
  flagWeekend: true,
};

function normMerchant(m: string | null): string {
  return (m ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Weekend check on the calendar date alone. Parses YYYY-MM-DD at UTC noon so no
 * timezone can shift the weekday. Returns false for an unparseable date.
 */
function isWeekend(isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Evaluate every line against the policy. Deterministic: duplicate detection
 * groups by merchant+amount+date across the whole set, so the same input always
 * yields the same flags in the same order.
 */
export function evaluateExpensePolicy(
  lines: PolicyLineInput[],
  config: ExpensePolicyConfig = DEFAULT_EXPENSE_POLICY
): PolicyResult {
  const receiptThreshold = config.receiptRequiredOverCents;
  const perExpenseMax = config.perExpenseMaxCents ?? 0;
  const personal = new Set(config.personalCategoryKeys ?? []);
  const flagWeekend = config.flagWeekend ?? true;

  // Duplicate grouping — count identical (merchant, amount, date) signatures.
  const dupCounts = new Map<string, number>();
  for (const l of lines) {
    const sig = `${normMerchant(l.merchant)}|${l.amountCents}|${l.expenseDate}`;
    dupCounts.set(sig, (dupCounts.get(sig) ?? 0) + 1);
  }

  const results: PolicyLineResult[] = lines.map((l) => {
    const flags: PolicyFlag[] = [];

    // OVER_CATEGORY_LIMIT
    if (l.categoryKey != null) {
      const cap = config.categoryLimitsCents[l.categoryKey];
      if (typeof cap === 'number' && cap > 0 && l.amountCents > cap) {
        flags.push({
          code: 'OVER_CATEGORY_LIMIT',
          message: `${money(l.amountCents)} exceeds the ${money(cap)} category limit`,
          severity: 'warn',
        });
      }
    }

    // OVER_MAX
    if (perExpenseMax > 0 && l.amountCents > perExpenseMax) {
      flags.push({
        code: 'OVER_MAX',
        message: `${money(l.amountCents)} exceeds the ${money(perExpenseMax)} per-expense ceiling`,
        severity: 'block',
      });
    }

    // MISSING_RECEIPT
    if (!l.hasReceipt && l.amountCents >= receiptThreshold) {
      flags.push({
        code: 'MISSING_RECEIPT',
        message: `Receipt required for expenses at or above ${money(receiptThreshold)}`,
        severity: 'warn',
      });
    }

    // PERSONAL_ON_CARD
    if (
      l.paymentSource === 'CORPORATE_CARD' &&
      l.categoryKey != null &&
      personal.has(l.categoryKey)
    ) {
      flags.push({
        code: 'PERSONAL_ON_CARD',
        message: 'Personal-category expense charged to the corporate card',
        severity: 'block',
      });
    }

    // DUPLICATE
    const sig = `${normMerchant(l.merchant)}|${l.amountCents}|${l.expenseDate}`;
    if ((dupCounts.get(sig) ?? 0) > 1) {
      flags.push({
        code: 'DUPLICATE',
        message: 'Possible duplicate — same merchant, amount, and date appears more than once',
        severity: 'warn',
      });
    }

    // WEEKEND_EXPENSE
    if (flagWeekend && isWeekend(l.expenseDate)) {
      flags.push({
        code: 'WEEKEND_EXPENSE',
        message: 'Expense dated on a weekend',
        severity: 'info',
      });
    }

    return { lineId: l.id, flags, flagged: flags.length > 0 };
  });

  return {
    lines: results,
    flaggedCount: results.filter((r) => r.flagged).length,
  };
}

// ---------------------------------------------------------------------------
// Ruleset-driven evaluation — the live path. DELEGATES to the deterministic
// engine (policy-engine.ts) for every policy-driven rule, then folds in the two
// always-on, policy-independent heuristics (DUPLICATE, WEEKEND) so the reviewer
// still sees those regardless of whether a policy is active.
// ---------------------------------------------------------------------------

/** Result shape for the ruleset path: PolicyResult + the routing/block summary. */
export interface RulesetPolicyResult extends PolicyResult {
  /** Number of BLOCK-severity flags across the report. */
  blockCount: number;
  /** Number of WARN-severity flags across the report. */
  warnCount: number;
  /** Approval tier required for the report total (null when no tiers defined). */
  requiredApprovalTier: string | null;
}

/** Map an engine severity (WARN|BLOCK) onto the stored PolicySeverity vocab. */
function engineSeverity(s: EngineRuleSeverity): PolicySeverity {
  return s === 'BLOCK' ? 'block' : 'warn';
}

/**
 * Evaluate report lines against the ACTIVE compiled ruleset. The engine owns all
 * limit / receipt / prohibited / per-diem / cap / approval-tier logic; here we
 * add the DUPLICATE and WEEKEND heuristics (never blocking) and shape the result
 * into the stored `policy_reasons` form the UI already renders.
 */
export function evaluateLinesWithRuleset(
  lines: PolicyLineInput[],
  ruleset: ExpensePolicyRuleset
): RulesetPolicyResult {
  const engineLines: EngineLine[] = lines.map((l) => ({
    id: l.id,
    amountCents: l.amountCents,
    accountId: l.categoryKey,
    categoryLabel: l.merchant,
    hasReceipt: l.hasReceipt,
    paymentSource: l.paymentSource,
    expenseDate: l.expenseDate,
  }));

  const report = evaluateReport(engineLines, ruleset);
  const byLine = new Map(report.lines.map((e) => [e.lineId, e]));

  // Always-on DUPLICATE grouping (policy-independent, informational/warn).
  const dupCounts = new Map<string, number>();
  for (const l of lines) {
    const sig = `${normMerchant(l.merchant)}|${l.amountCents}|${l.expenseDate}`;
    dupCounts.set(sig, (dupCounts.get(sig) ?? 0) + 1);
  }

  const results: PolicyLineResult[] = lines.map((l) => {
    const flags: PolicyFlag[] = [];

    // Engine (policy-driven) violations first.
    const ev = byLine.get(l.id);
    if (ev) {
      for (const v of ev.violations) {
        flags.push({
          code: v.rule_id as PolicyFlagCode,
          message: v.message,
          severity: engineSeverity(v.severity),
        });
      }
    }

    // DUPLICATE heuristic.
    const sig = `${normMerchant(l.merchant)}|${l.amountCents}|${l.expenseDate}`;
    if ((dupCounts.get(sig) ?? 0) > 1) {
      flags.push({
        code: 'DUPLICATE',
        message: 'Possible duplicate — same merchant, amount, and date appears more than once',
        severity: 'warn',
      });
    }

    // WEEKEND heuristic (informational only).
    if (isWeekend(l.expenseDate)) {
      flags.push({ code: 'WEEKEND_EXPENSE', message: 'Expense dated on a weekend', severity: 'info' });
    }

    return { lineId: l.id, flags, flagged: flags.length > 0 };
  });

  let blockCount = 0;
  let warnCount = 0;
  for (const r of results) {
    for (const f of r.flags) {
      if (f.severity === 'block') blockCount += 1;
      else if (f.severity === 'warn') warnCount += 1;
    }
  }

  return {
    lines: results,
    flaggedCount: results.filter((r) => r.flagged).length,
    blockCount,
    warnCount,
    requiredApprovalTier: report.requiredApprovalTier,
  };
}
