/**
 * THE EXPENSE-POLICY RULESET SCHEMA — the fixed contract that turns a company's
 * written expense policy into STRUCTURED DATA (never code).
 *
 * SAFETY BOUNDARY (this is a fintech book of record): the AI policy compiler
 * (`policy-compile.ts`) may ONLY emit an object that validates against THIS Zod
 * schema. It never generates code, SQL, or free-form logic. Any clause the schema
 * cannot express is captured verbatim in `unmappedClauses` and handed to a human
 * ("unmapped rule — needs manual handling") — it is NEVER silently turned into
 * behavior. The deterministic engine (`policy-engine.ts`) reads ONLY this shape.
 * That is the "config, not codegen" guarantee.
 *
 * Money is bigint cents everywhere (canon). A "rate" that is naturally fractional
 * (mileage) is expressed as an INTEGER cents-per-mile so no float touches money.
 *
 * This schema is versioned by `schemaVersion` (the SHAPE version) — distinct from
 * the per-tenant policy row `version` in `expense_policies` (migration 086).
 */

import { z } from 'zod';

/** The current ruleset SHAPE version. Bump only on a breaking vocabulary change. */
export const RULESET_SCHEMA_VERSION = 1 as const;

/** A non-negative integer cent amount. */
const cents = z.number().int().min(0);

/** Every rule breach is either advisory (WARN) or a hard stop (BLOCK). */
export const ruleSeveritySchema = z.enum(['WARN', 'BLOCK']);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

/**
 * One spending category the policy governs (meals, lodging, airfare, alcohol,
 * entertainment, …). `category` is a canonical UPPER_SNAKE token the engine keys
 * on; a line is matched to a rule either by its GL account id (`matchAccountIds`)
 * or, failing that, by keyword against the line's merchant/description/account
 * name (`matchKeywords`). All matching is deterministic and case-insensitive.
 */
export const categoryRuleSchema = z
  .object({
    category: z.string().min(1).max(80),
    label: z.string().max(120).optional(),
    /** GL account ids that deterministically map to this category. */
    matchAccountIds: z.array(z.string().uuid()).max(500).default([]),
    /** Lowercased keywords matched against merchant/description/account name. */
    matchKeywords: z.array(z.string().min(1).max(60)).max(50).default([]),
    /** Per single-expense cap (cents). null = no cap. */
    perExpenseLimitCents: cents.nullable().default(null),
    /** Per calendar-day cap across the report (cents). null = no cap. */
    perDayLimitCents: cents.nullable().default(null),
    /** Per report/trip cap (cents). null = no cap. */
    perTripLimitCents: cents.nullable().default(null),
    /** This category may not be expensed at all. */
    prohibited: z.boolean().default(false),
    /** This category requires documented pre-approval. */
    preApprovalRequired: z.boolean().default(false),
    /** Severity applied when a limit on this category is breached. */
    severity: ruleSeveritySchema.default('BLOCK'),
  })
  .strict();
export type CategoryRule = z.infer<typeof categoryRuleSchema>;

/** A per-diem override for a named location (city/region as written in policy). */
export const perDiemLocationSchema = z
  .object({
    location: z.string().min(1).max(120),
    dailyCents: cents,
  })
  .strict();
export type PerDiemLocation = z.infer<typeof perDiemLocationSchema>;

/** Per-diem configuration — a daily allowance, optionally varying by location. */
export const perDiemSchema = z
  .object({
    enabled: z.boolean().default(false),
    defaultDailyCents: cents.nullable().default(null),
    byLocation: z.array(perDiemLocationSchema).max(1000).default([]),
    /** Category tokens the per-diem allowance applies to (e.g. MEALS, LODGING). */
    appliesToCategories: z.array(z.string().min(1).max(80)).max(50).default([]),
    severity: ruleSeveritySchema.default('WARN'),
  })
  .strict();
export type PerDiem = z.infer<typeof perDiemSchema>;

/**
 * One amount-tiered approval-routing rule. `uptoCents` is the inclusive upper
 * bound the tier covers; `null` is the catch-all "everything above" tier. The
 * engine sorts these ascending (null last) and picks the first that fits.
 */
export const approvalTierSchema = z
  .object({
    uptoCents: cents.nullable(),
    tier: z.string().min(1).max(60),
  })
  .strict();
export type ApprovalTier = z.infer<typeof approvalTierSchema>;

/**
 * A clause the schema could NOT express. Kept verbatim for a human to handle
 * manually — the machine will not enforce it. This is the pressure-release valve
 * that keeps the compiler honest: no clause is ever forced into a rule it doesn't
 * fit.
 */
export const unmappedClauseSchema = z
  .object({
    text: z.string().min(1).max(2000),
    note: z.string().max(500).optional(),
  })
  .strict();
export type UnmappedClause = z.infer<typeof unmappedClauseSchema>;

/**
 * THE COMPILED RULESET — the whole machine-readable policy. Persisted as
 * `expense_policies.compiled_rules` (jsonb) and validated against this schema on
 * every read and write. The engine treats a missing/optional field as "no rule",
 * so the empty ruleset (`DEFAULT_RULESET`) is a valid, fully non-blocking policy.
 */
export const expensePolicyRulesetSchema = z
  .object({
    schemaVersion: z.literal(RULESET_SCHEMA_VERSION).default(RULESET_SCHEMA_VERSION),
    currency: z.string().length(3).default('USD'),

    categories: z.array(categoryRuleSchema).max(300).default([]),

    /** Receipt required at/above this amount (cents). null = never required. */
    receiptRequiredOverCents: cents.nullable().default(null),
    receiptRuleSeverity: ruleSeveritySchema.default('WARN'),

    /** Absolute per-expense ceiling regardless of category (cents). null = none. */
    perExpenseCeilingCents: cents.nullable().default(null),
    perExpenseCeilingSeverity: ruleSeveritySchema.default('BLOCK'),

    perDiem: perDiemSchema.default({}),

    /** Reimbursement rate for mileage, in INTEGER cents per mile (e.g. 67). */
    mileageRateCentsPerMile: cents.nullable().default(null),

    /** Hard cap on a single alcohol-category expense (cents). null = none. */
    alcoholCapCents: cents.nullable().default(null),
    /** Hard cap on a single entertainment-category expense (cents). null = none. */
    entertainmentCapCents: cents.nullable().default(null),
    /** Severity for the alcohol / entertainment caps. */
    discretionaryCapSeverity: ruleSeveritySchema.default('WARN'),

    approvalTiers: z.array(approvalTierSchema).max(20).default([]),

    unmappedClauses: z.array(unmappedClauseSchema).max(300).default([]),

    /** A short human summary of the source document (for the review screen). */
    sourceSummary: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type ExpensePolicyRuleset = z.infer<typeof expensePolicyRulesetSchema>;

/**
 * The conservative default when NO policy is ACTIVE: an empty, fully non-blocking
 * ruleset. The engine yields zero violations and a null tier against it, so the
 * expense flow degrades safely — nothing is blocked, nothing breaks.
 */
export const DEFAULT_RULESET: ExpensePolicyRuleset = expensePolicyRulesetSchema.parse({});

/** Canonical category tokens the compiler prefers (extensible — not exhaustive). */
export const CANONICAL_CATEGORY_TOKENS = [
  'MEALS',
  'LODGING',
  'AIRFARE',
  'GROUND_TRANSPORT',
  'CAR_RENTAL',
  'MILEAGE',
  'ENTERTAINMENT',
  'ALCOHOL',
  'OFFICE_SUPPLIES',
  'SOFTWARE',
  'CONFERENCES',
  'GIFTS',
  'TELECOM',
  'OTHER',
] as const;

/**
 * Validate an unknown value as a ruleset. Returns the parsed ruleset or a list of
 * human-readable errors. Used by the engine loader and the create/activate routes
 * so a malformed `compiled_rules` blob can NEVER reach enforcement.
 */
export function parseRuleset(
  input: unknown
): { ok: true; ruleset: ExpensePolicyRuleset } | { ok: false; errors: string[] } {
  const res = expensePolicyRulesetSchema.safeParse(input);
  if (res.success) return { ok: true, ruleset: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
