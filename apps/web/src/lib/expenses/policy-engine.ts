/**
 * THE DETERMINISTIC EXPENSE-POLICY ENGINE.
 *
 * PURE and side-effect-free — no I/O, no clock, no randomness, no model. Given a
 * set of expense lines and a compiled ruleset (validated by `policy-schema.ts`),
 * it produces the SAME violations and the SAME approval tier every time. This is
 * the hand-written, auditable evaluator the AI is deliberately kept away from: the
 * AI only ever produces the DATA (the ruleset); this code is the only thing that
 * acts on an expense.
 *
 * It emits WARN (advisory — surfaced to the approver) and BLOCK (a hard stop —
 * blocks submission unless a human records an explicit override with reason). It
 * also selects the required approval tier from the amount-tiered routing rules.
 *
 * Money is bigint cents throughout.
 */

import type {
  ExpensePolicyRuleset,
  CategoryRule,
  RuleSeverity,
  ApprovalTier,
} from './policy-schema';

export type PaymentSource = 'OUT_OF_POCKET' | 'CORPORATE_CARD';

/** One expense line as the engine sees it. The caller maps DB rows onto this. */
export interface EngineLine {
  id: string;
  amountCents: number;
  /** GL account id used for category matching (may be null while uncoded). */
  accountId: string | null;
  /** Merchant / description / account-name text used for keyword matching. */
  categoryLabel: string | null;
  hasReceipt: boolean;
  paymentSource: PaymentSource;
  /** ISO YYYY-MM-DD. Only the calendar date is used (for per-day grouping). */
  expenseDate: string;
  /** True when a documented pre-approval exists (defaults false). */
  preApproved?: boolean;
  /** Optional location token for per-diem-by-location resolution. */
  locationName?: string | null;
}

/** A stable machine id per rule kind — cited in the UI and stored on the line. */
export type ViolationRuleId =
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

export interface PolicyViolation {
  rule_id: ViolationRuleId;
  severity: RuleSeverity;
  message: string;
  category?: string;
  limitCents?: number;
  actualCents?: number;
}

export interface LineEvaluation {
  lineId: string;
  violations: PolicyViolation[];
  /** The category token this line resolved to (null when nothing matched). */
  matchedCategory: string | null;
  /** Approval tier required for THIS line's amount (null when no tiers defined). */
  requiredApprovalTier: string | null;
}

export interface ReportEvaluation {
  lines: LineEvaluation[];
  /** Approval tier required for the report TOTAL (null when no tiers defined). */
  requiredApprovalTier: string | null;
  blockCount: number;
  warnCount: number;
  flaggedLineIds: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Resolve a line to at most one category rule. Deterministic precedence:
 *   1. GL account id is in the rule's `matchAccountIds`.
 *   2. Any of the rule's `matchKeywords` appears in the line's label OR the rule's
 *      `category`/`label` token appears in the label.
 * The FIRST rule (in ruleset order) that matches wins, so ordering is stable.
 */
export function resolveCategory(
  line: Pick<EngineLine, 'accountId' | 'categoryLabel'>,
  ruleset: ExpensePolicyRuleset
): CategoryRule | null {
  const label = norm(line.categoryLabel);

  // Pass 1: exact GL account match (strongest, unambiguous signal).
  if (line.accountId) {
    for (const c of ruleset.categories) {
      if (c.matchAccountIds.includes(line.accountId)) return c;
    }
  }

  // Pass 2: keyword / token match against the label.
  if (label) {
    for (const c of ruleset.categories) {
      const tokens = [
        ...c.matchKeywords.map(norm),
        norm(c.category).replace(/_/g, ' '),
        norm(c.label),
      ].filter(Boolean);
      if (tokens.some((t) => t && label.includes(t))) return c;
    }
  }

  return null;
}

/**
 * Select the approval tier for an amount. Tiers are sorted ascending by
 * `uptoCents` (null — the catch-all — last); the first whose bound covers the
 * amount is returned. No tiers => null.
 */
export function pickApprovalTier(
  amountCents: number,
  tiers: ApprovalTier[]
): string | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => {
    if (a.uptoCents === null) return 1;
    if (b.uptoCents === null) return -1;
    return a.uptoCents - b.uptoCents;
  });
  for (const t of sorted) {
    if (t.uptoCents === null || amountCents <= t.uptoCents) return t.tier;
  }
  // Amount exceeds every finite tier and there was no catch-all — highest tier.
  return sorted[sorted.length - 1]?.tier ?? null;
}

// ---------------------------------------------------------------------------
// Single-line evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate ONE line against the ruleset. Deterministic; considers only the line
 * itself (per-day / per-trip aggregates are added by `evaluateReport`).
 */
export function evaluateExpense(
  line: EngineLine,
  ruleset: ExpensePolicyRuleset
): LineEvaluation {
  const violations: PolicyViolation[] = [];
  const cat = resolveCategory(line, ruleset);
  const catToken = cat?.category ?? null;

  // ── Prohibited category ────────────────────────────────────────────────────
  if (cat?.prohibited) {
    violations.push({
      rule_id: 'CATEGORY_PROHIBITED',
      severity: 'BLOCK',
      message: `${cat.label ?? cat.category} is a prohibited expense category`,
      category: cat.category,
      actualCents: line.amountCents,
    });
  }

  // ── Pre-approval required ──────────────────────────────────────────────────
  if (cat?.preApprovalRequired && !line.preApproved) {
    violations.push({
      rule_id: 'PREAPPROVAL_REQUIRED',
      severity: 'WARN',
      message: `${cat.label ?? cat.category} requires documented pre-approval`,
      category: cat.category,
      actualCents: line.amountCents,
    });
  }

  // ── Per-expense category limit ─────────────────────────────────────────────
  if (cat && cat.perExpenseLimitCents !== null && line.amountCents > cat.perExpenseLimitCents) {
    violations.push({
      rule_id: 'CATEGORY_PER_EXPENSE_LIMIT',
      severity: cat.severity,
      message: `${money(line.amountCents)} exceeds the ${money(
        cat.perExpenseLimitCents
      )} per-expense limit for ${cat.label ?? cat.category}`,
      category: cat.category,
      limitCents: cat.perExpenseLimitCents,
      actualCents: line.amountCents,
    });
  }

  // ── Absolute per-expense ceiling (category-independent) ────────────────────
  if (
    ruleset.perExpenseCeilingCents !== null &&
    line.amountCents > ruleset.perExpenseCeilingCents
  ) {
    violations.push({
      rule_id: 'ABSOLUTE_CEILING',
      severity: ruleset.perExpenseCeilingSeverity,
      message: `${money(line.amountCents)} exceeds the ${money(
        ruleset.perExpenseCeilingCents
      )} per-expense ceiling`,
      limitCents: ruleset.perExpenseCeilingCents,
      actualCents: line.amountCents,
    });
  }

  // ── Receipt required threshold ─────────────────────────────────────────────
  if (
    ruleset.receiptRequiredOverCents !== null &&
    !line.hasReceipt &&
    line.amountCents >= ruleset.receiptRequiredOverCents
  ) {
    violations.push({
      rule_id: 'RECEIPT_REQUIRED',
      severity: ruleset.receiptRuleSeverity,
      message: `Receipt required for expenses at or above ${money(
        ruleset.receiptRequiredOverCents
      )}`,
      limitCents: ruleset.receiptRequiredOverCents,
      actualCents: line.amountCents,
    });
  }

  // ── Alcohol cap ────────────────────────────────────────────────────────────
  if (
    ruleset.alcoholCapCents !== null &&
    catToken === 'ALCOHOL' &&
    line.amountCents > ruleset.alcoholCapCents
  ) {
    violations.push({
      rule_id: 'ALCOHOL_CAP',
      severity: ruleset.discretionaryCapSeverity,
      message: `${money(line.amountCents)} exceeds the ${money(
        ruleset.alcoholCapCents
      )} alcohol cap`,
      category: 'ALCOHOL',
      limitCents: ruleset.alcoholCapCents,
      actualCents: line.amountCents,
    });
  }

  // ── Entertainment cap ──────────────────────────────────────────────────────
  if (
    ruleset.entertainmentCapCents !== null &&
    catToken === 'ENTERTAINMENT' &&
    line.amountCents > ruleset.entertainmentCapCents
  ) {
    violations.push({
      rule_id: 'ENTERTAINMENT_CAP',
      severity: ruleset.discretionaryCapSeverity,
      message: `${money(line.amountCents)} exceeds the ${money(
        ruleset.entertainmentCapCents
      )} entertainment cap`,
      category: 'ENTERTAINMENT',
      limitCents: ruleset.entertainmentCapCents,
      actualCents: line.amountCents,
    });
  }

  // ── Per-diem ───────────────────────────────────────────────────────────────
  if (ruleset.perDiem.enabled && catToken && ruleset.perDiem.appliesToCategories.includes(catToken)) {
    const daily = resolvePerDiemDaily(ruleset, line.locationName);
    if (daily !== null && line.amountCents > daily) {
      violations.push({
        rule_id: 'PER_DIEM_EXCEEDED',
        severity: ruleset.perDiem.severity,
        message: `${money(line.amountCents)} exceeds the ${money(daily)} per-diem allowance`,
        category: catToken,
        limitCents: daily,
        actualCents: line.amountCents,
      });
    }
  }

  return {
    lineId: line.id,
    violations,
    matchedCategory: catToken,
    requiredApprovalTier: pickApprovalTier(line.amountCents, ruleset.approvalTiers),
  };
}

/** Resolve the applicable per-diem daily allowance (by location, else default). */
function resolvePerDiemDaily(
  ruleset: ExpensePolicyRuleset,
  locationName: string | null | undefined
): number | null {
  const loc = norm(locationName);
  if (loc) {
    for (const l of ruleset.perDiem.byLocation) {
      if (norm(l.location) === loc || loc.includes(norm(l.location))) return l.dailyCents;
    }
  }
  return ruleset.perDiem.defaultDailyCents;
}

// ---------------------------------------------------------------------------
// Report-level evaluation (adds per-day / per-trip aggregate limits)
// ---------------------------------------------------------------------------

/**
 * Evaluate a whole report. Runs the single-line rules, then layers on the
 * aggregate limits that only make sense across lines (per-day and per-trip
 * category caps). Deterministic across the full set. The report's required
 * approval tier is selected from the report TOTAL amount.
 */
export function evaluateReport(
  lines: EngineLine[],
  ruleset: ExpensePolicyRuleset
): ReportEvaluation {
  const perLine = new Map<string, LineEvaluation>();
  for (const l of lines) perLine.set(l.id, evaluateExpense(l, ruleset));

  // Resolve each line's category once (reuse for grouping).
  const catOf = new Map<string, CategoryRule | null>();
  for (const l of lines) catOf.set(l.id, resolveCategory(l, ruleset));

  // ── Per-day category limits ────────────────────────────────────────────────
  // Group by (category token, date); if the group total exceeds the category's
  // per-day cap, flag EVERY line in the group so the reviewer sees the cause.
  const dayGroups = new Map<string, { cat: CategoryRule; lineIds: string[]; total: number }>();
  for (const l of lines) {
    const c = catOf.get(l.id);
    if (!c || c.perDayLimitCents === null) continue;
    const key = `${c.category}|${l.expenseDate}`;
    const g = dayGroups.get(key) ?? { cat: c, lineIds: [], total: 0 };
    g.lineIds.push(l.id);
    g.total += l.amountCents;
    dayGroups.set(key, g);
  }
  for (const g of dayGroups.values()) {
    if (g.cat.perDayLimitCents !== null && g.total > g.cat.perDayLimitCents) {
      for (const id of g.lineIds) {
        perLine.get(id)!.violations.push({
          rule_id: 'CATEGORY_PER_DAY_LIMIT',
          severity: g.cat.severity,
          message: `${money(g.total)} in ${g.cat.label ?? g.cat.category} on this day exceeds the ${money(
            g.cat.perDayLimitCents
          )} daily limit`,
          category: g.cat.category,
          limitCents: g.cat.perDayLimitCents,
          actualCents: g.total,
        });
      }
    }
  }

  // ── Per-trip (whole-report) category limits ────────────────────────────────
  const tripGroups = new Map<string, { cat: CategoryRule; lineIds: string[]; total: number }>();
  for (const l of lines) {
    const c = catOf.get(l.id);
    if (!c || c.perTripLimitCents === null) continue;
    const g = tripGroups.get(c.category) ?? { cat: c, lineIds: [], total: 0 };
    g.lineIds.push(l.id);
    g.total += l.amountCents;
    tripGroups.set(c.category, g);
  }
  for (const g of tripGroups.values()) {
    if (g.cat.perTripLimitCents !== null && g.total > g.cat.perTripLimitCents) {
      for (const id of g.lineIds) {
        perLine.get(id)!.violations.push({
          rule_id: 'CATEGORY_PER_TRIP_LIMIT',
          severity: g.cat.severity,
          message: `${money(g.total)} in ${g.cat.label ?? g.cat.category} on this report exceeds the ${money(
            g.cat.perTripLimitCents
          )} per-trip limit`,
          category: g.cat.category,
          limitCents: g.cat.perTripLimitCents,
          actualCents: g.total,
        });
      }
    }
  }

  // ── Totals + report tier ───────────────────────────────────────────────────
  let blockCount = 0;
  let warnCount = 0;
  const flaggedLineIds: string[] = [];
  for (const ev of perLine.values()) {
    if (ev.violations.length > 0) flaggedLineIds.push(ev.lineId);
    for (const v of ev.violations) {
      if (v.severity === 'BLOCK') blockCount += 1;
      else warnCount += 1;
    }
  }

  const reportTotal = lines.reduce((s, l) => s + l.amountCents, 0);

  return {
    lines: Array.from(perLine.values()),
    requiredApprovalTier: pickApprovalTier(reportTotal, ruleset.approvalTiers),
    blockCount,
    warnCount,
    flaggedLineIds,
  };
}

/** Compute the reimbursable mileage amount (cents) for a distance, or null. */
export function mileageAmountCents(
  miles: number,
  ruleset: ExpensePolicyRuleset
): number | null {
  if (ruleset.mileageRateCentsPerMile === null) return null;
  if (!Number.isFinite(miles) || miles < 0) return null;
  return Math.round(miles * ruleset.mileageRateCentsPerMile);
}
