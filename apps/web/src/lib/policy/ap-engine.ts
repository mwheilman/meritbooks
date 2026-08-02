/**
 * THE DETERMINISTIC AP (BILL-APPROVAL) POLICY ENGINE.
 *
 * PURE and side-effect-free — no I/O, no clock, no randomness, no model. Given a bill
 * and a compiled AP ruleset (validated by `ap-schema.ts`), it produces the SAME
 * violations, the SAME required approval tier, and the SAME blocked verdict every time.
 * This is the hand-written, auditable evaluator the AI is deliberately kept away from:
 * the AI only ever produces the DATA (the ruleset); this code is the only thing that
 * acts on a bill.
 *
 * It emits WARN (advisory — surfaced to the approver) and BLOCK (a hard stop — the bill
 * cannot be created/approved unless a human records an explicit audited override). It
 * also selects the required approval tier from the bill total.
 *
 * Money is bigint cents throughout.
 */

import { pickAmountTier, type PolicySeverity } from './core';
import type { ApPolicyRuleset, VendorRule, CategoryRule } from './ap-schema';

/** Verdict of a 3-way match (PO ↔ receipt ↔ bill), from `bill_po_links.match_status`. */
export type ThreeWayMatchStatus = 'NONE' | 'PENDING' | 'MATCHED' | 'EXCEPTION' | 'OVERRIDDEN';

/** One bill line as the engine sees it. The caller maps DB rows onto this. */
export interface ApBillLine {
  /** GL account id used for category matching (may be null while uncoded). */
  accountId: string | null;
  /** GL account NUMBER used for category matching (may be null). */
  accountNumber: string | null;
  /** Line description / account name text used for keyword matching. */
  categoryLabel: string | null;
  amountCents: number;
}

/** One bill as the engine sees it. */
export interface ApBillSubject {
  billId: string;
  vendorId: string | null;
  vendorName: string | null;
  totalCents: number;
  lines: ApBillLine[];
  /** Whether a purchase order is linked to this bill. */
  hasPurchaseOrder: boolean;
  /** The 3-way match verdict for the linked PO (NONE when no PO). */
  threeWayMatchStatus: ThreeWayMatchStatus;
  /** Whether the caller detected a likely duplicate (same vendor + number + amount). */
  isSuspectedDuplicate: boolean;
}

export type ApViolationRuleId =
  | 'VENDOR_PROHIBITED'
  | 'VENDOR_BILL_LIMIT'
  | 'CATEGORY_PROHIBITED'
  | 'CATEGORY_LINE_LIMIT'
  | 'CATEGORY_BILL_LIMIT'
  | 'PER_BILL_CEILING'
  | 'PO_REQUIRED'
  | 'THREE_WAY_MATCH_REQUIRED'
  | 'DUPLICATE_BILL';

export interface ApPolicyViolation {
  rule_id: ApViolationRuleId;
  severity: PolicySeverity;
  message: string;
  vendorId?: string;
  category?: string;
  limitCents?: number;
  actualCents?: number;
}

export interface ApBillEvaluation {
  violations: ApPolicyViolation[];
  /** Approval tier required for the bill TOTAL (null when no tiers defined). */
  requiredApprovalTier: string | null;
  /** True when ANY violation is BLOCK severity — create/approve needs an override. */
  blocked: boolean;
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
 * Resolve a bill to at most one vendor rule. Deterministic precedence:
 *   1. exact core vendor id match (`matchVendorId`).
 *   2. any keyword appears in the vendor name.
 * FIRST rule (in ruleset order) that matches wins, so ordering is stable.
 */
export function resolveVendorRule(
  bill: Pick<ApBillSubject, 'vendorId' | 'vendorName'>,
  ruleset: ApPolicyRuleset
): VendorRule | null {
  if (bill.vendorId) {
    for (const v of ruleset.vendors) {
      if (v.matchVendorId && v.matchVendorId === bill.vendorId) return v;
    }
  }
  const name = norm(bill.vendorName);
  if (name) {
    for (const v of ruleset.vendors) {
      if (v.matchKeywords.some((k) => k && name.includes(norm(k)))) return v;
    }
  }
  return null;
}

/**
 * Resolve a line to at most one category rule. Deterministic precedence:
 *   1. GL account id ∈ `matchAccountIds`.
 *   2. GL account number ∈ `matchAccountNumbers`.
 *   3. any keyword / the category token appears in the line label.
 */
export function resolveCategoryRule(
  line: Pick<ApBillLine, 'accountId' | 'accountNumber' | 'categoryLabel'>,
  ruleset: ApPolicyRuleset
): CategoryRule | null {
  if (line.accountId) {
    for (const c of ruleset.categories) {
      if (c.matchAccountIds.includes(line.accountId)) return c;
    }
  }
  if (line.accountNumber) {
    for (const c of ruleset.categories) {
      if (c.matchAccountNumbers.includes(line.accountNumber)) return c;
    }
  }
  const label = norm(line.categoryLabel);
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

// ---------------------------------------------------------------------------
// Bill evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate ONE bill against the ruleset. Deterministic and total: every rule kind is
 * checked, violations are accumulated, the approval tier is chosen from the bill total,
 * and `blocked` is true iff any violation is BLOCK severity.
 */
export function evaluateBill(bill: ApBillSubject, ruleset: ApPolicyRuleset): ApBillEvaluation {
  const violations: ApPolicyViolation[] = [];

  // ── Vendor rules ───────────────────────────────────────────────────────────
  const vendorRule = resolveVendorRule(bill, ruleset);
  if (vendorRule) {
    if (vendorRule.prohibited) {
      violations.push({
        rule_id: 'VENDOR_PROHIBITED',
        severity: vendorRule.severity,
        message: `${vendorRule.label ?? bill.vendorName ?? 'This vendor'} is a prohibited vendor — bills may not be posted`,
        vendorId: bill.vendorId ?? undefined,
        actualCents: bill.totalCents,
      });
    }
    if (vendorRule.perBillLimitCents !== null && bill.totalCents > vendorRule.perBillLimitCents) {
      violations.push({
        rule_id: 'VENDOR_BILL_LIMIT',
        severity: vendorRule.severity,
        message: `${money(bill.totalCents)} exceeds the ${money(vendorRule.perBillLimitCents)} per-bill limit for ${vendorRule.label ?? bill.vendorName ?? 'this vendor'}`,
        vendorId: bill.vendorId ?? undefined,
        limitCents: vendorRule.perBillLimitCents,
        actualCents: bill.totalCents,
      });
    }
  }

  // ── Category / GL rules (per-line + per-bill category totals) ───────────────
  const catTotals = new Map<string, { cat: CategoryRule; total: number }>();
  for (const line of bill.lines) {
    const cat = resolveCategoryRule(line, ruleset);
    if (!cat) continue;

    if (cat.prohibited) {
      violations.push({
        rule_id: 'CATEGORY_PROHIBITED',
        severity: cat.severity,
        message: `${cat.label ?? cat.category} is a prohibited spend category on bills`,
        category: cat.category,
        actualCents: line.amountCents,
      });
    }
    if (cat.perLineLimitCents !== null && line.amountCents > cat.perLineLimitCents) {
      violations.push({
        rule_id: 'CATEGORY_LINE_LIMIT',
        severity: cat.severity,
        message: `${money(line.amountCents)} exceeds the ${money(cat.perLineLimitCents)} per-line limit for ${cat.label ?? cat.category}`,
        category: cat.category,
        limitCents: cat.perLineLimitCents,
        actualCents: line.amountCents,
      });
    }
    const agg = catTotals.get(cat.category) ?? { cat, total: 0 };
    agg.total += line.amountCents;
    catTotals.set(cat.category, agg);
  }
  for (const { cat, total } of catTotals.values()) {
    if (cat.perBillLimitCents !== null && total > cat.perBillLimitCents) {
      violations.push({
        rule_id: 'CATEGORY_BILL_LIMIT',
        severity: cat.severity,
        message: `${money(total)} in ${cat.label ?? cat.category} on this bill exceeds the ${money(cat.perBillLimitCents)} category limit`,
        category: cat.category,
        limitCents: cat.perBillLimitCents,
        actualCents: total,
      });
    }
  }

  // ── Absolute per-bill ceiling ──────────────────────────────────────────────
  if (ruleset.perBillCeilingCents !== null && bill.totalCents > ruleset.perBillCeilingCents) {
    violations.push({
      rule_id: 'PER_BILL_CEILING',
      severity: ruleset.perBillCeilingSeverity,
      message: `${money(bill.totalCents)} exceeds the ${money(ruleset.perBillCeilingCents)} per-bill ceiling`,
      limitCents: ruleset.perBillCeilingCents,
      actualCents: bill.totalCents,
    });
  }

  // ── PO required over threshold ─────────────────────────────────────────────
  if (
    ruleset.requirePoOverCents !== null &&
    bill.totalCents >= ruleset.requirePoOverCents &&
    !bill.hasPurchaseOrder
  ) {
    violations.push({
      rule_id: 'PO_REQUIRED',
      severity: ruleset.requirePoSeverity,
      message: `A purchase order is required for bills at or above ${money(ruleset.requirePoOverCents)}`,
      limitCents: ruleset.requirePoOverCents,
      actualCents: bill.totalCents,
    });
  }

  // ── 3-way match required over threshold ────────────────────────────────────
  // A CLEAN match is MATCHED or (human-cleared) OVERRIDDEN. NONE / PENDING / EXCEPTION fail.
  if (
    ruleset.requireThreeWayMatchOverCents !== null &&
    bill.totalCents >= ruleset.requireThreeWayMatchOverCents &&
    bill.threeWayMatchStatus !== 'MATCHED' &&
    bill.threeWayMatchStatus !== 'OVERRIDDEN'
  ) {
    violations.push({
      rule_id: 'THREE_WAY_MATCH_REQUIRED',
      severity: ruleset.threeWayMatchSeverity,
      message: `A clean 3-way match (PO ↔ receipt ↔ bill) is required for bills at or above ${money(ruleset.requireThreeWayMatchOverCents)} (current: ${bill.threeWayMatchStatus})`,
      limitCents: ruleset.requireThreeWayMatchOverCents,
      actualCents: bill.totalCents,
    });
  }

  // ── Duplicate bill block ───────────────────────────────────────────────────
  if (ruleset.duplicateBillBlock && bill.isSuspectedDuplicate) {
    violations.push({
      rule_id: 'DUPLICATE_BILL',
      severity: ruleset.duplicateBillSeverity,
      message: 'A bill with the same vendor, bill number, and amount already exists — suspected duplicate',
      vendorId: bill.vendorId ?? undefined,
      actualCents: bill.totalCents,
    });
  }

  return {
    violations,
    requiredApprovalTier: pickAmountTier(bill.totalCents, ruleset.approvalTiers),
    blocked: violations.some((v) => v.severity === 'BLOCK'),
  };
}
