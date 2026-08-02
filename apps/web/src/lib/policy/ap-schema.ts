/**
 * THE AP (BILL-APPROVAL) RULESET SCHEMA — the fixed contract that turns a company's
 * written accounts-payable / bill-approval policy into STRUCTURED DATA (never code).
 *
 * This is the AP counterpart of the expense-policy schema (lib/expenses/policy-schema.ts);
 * both are validated, versioned, human-approved rulesets read by a deterministic engine.
 * The AI compiler (`ap-compile.ts`) may ONLY emit an object that validates against THIS
 * schema — never code, SQL, or free-form logic. Any clause the schema can't express is
 * captured verbatim in `unmappedClauses` for a human. That is the config-not-codegen
 * guarantee (canon §3).
 *
 * Money is bigint cents everywhere (canon). `schemaVersion` is the SHAPE version,
 * distinct from the per-tenant policy row `version` in `ap_approval_policies` (migration 088).
 */

import { z } from 'zod';

/** The current AP ruleset SHAPE version. Bump only on a breaking vocabulary change. */
export const AP_RULESET_SCHEMA_VERSION = 1 as const;

/** A non-negative integer cent amount. */
const cents = z.number().int().min(0);

export const ruleSeveritySchema = z.enum(['WARN', 'BLOCK']);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

/**
 * A per-vendor rule. A bill matches a vendor rule either by exact core vendor id
 * (`matchVendorId`, the strong signal) or by keyword against the vendor's name
 * (`matchKeywords`, deterministic + case-insensitive). Governs prohibited vendors and
 * per-vendor spend limits.
 */
export const vendorRuleSchema = z
  .object({
    label: z.string().max(160).optional(),
    /** Core vendor id this rule targets (strongest, unambiguous signal). */
    matchVendorId: z.string().uuid().nullable().default(null),
    /** Lowercased keywords matched against the vendor's name. */
    matchKeywords: z.array(z.string().min(1).max(80)).max(50).default([]),
    /** This vendor may not be billed at all (BLOCK by default). */
    prohibited: z.boolean().default(false),
    /** Per-bill cap for this vendor (cents). null = no cap. */
    perBillLimitCents: cents.nullable().default(null),
    severity: ruleSeveritySchema.default('BLOCK'),
  })
  .strict();
export type VendorRule = z.infer<typeof vendorRuleSchema>;

/**
 * A per-category / per-GL rule. A bill LINE is matched to a rule by its GL account id
 * (`matchAccountIds`), else its GL account NUMBER (`matchAccountNumbers`), else keyword
 * against the line description / account name (`matchKeywords`). Governs prohibited GL
 * lines, single-line caps, and per-bill category totals.
 */
export const categoryRuleSchema = z
  .object({
    category: z.string().min(1).max(80),
    label: z.string().max(120).optional(),
    matchAccountIds: z.array(z.string().uuid()).max(500).default([]),
    matchAccountNumbers: z.array(z.string().min(1).max(40)).max(500).default([]),
    matchKeywords: z.array(z.string().min(1).max(60)).max(50).default([]),
    /** Cap on a single bill line in this category (cents). null = none. */
    perLineLimitCents: cents.nullable().default(null),
    /** Cap on this category's TOTAL across the bill (cents). null = none. */
    perBillLimitCents: cents.nullable().default(null),
    /** This category/GL may not be billed at all. */
    prohibited: z.boolean().default(false),
    severity: ruleSeveritySchema.default('BLOCK'),
  })
  .strict();
export type CategoryRule = z.infer<typeof categoryRuleSchema>;

/**
 * One amount-tiered approval-routing rule. `uptoCents` is the inclusive upper bound the
 * tier covers; `null` is the catch-all "everything above". The engine sorts ascending
 * (null last) and picks the first that fits (shared `pickAmountTier`).
 */
export const approvalTierSchema = z
  .object({
    uptoCents: cents.nullable(),
    tier: z.string().min(1).max(60),
  })
  .strict();
export type ApprovalTier = z.infer<typeof approvalTierSchema>;

/** A clause the schema could NOT express — kept verbatim for a human. */
export const unmappedClauseSchema = z
  .object({
    text: z.string().min(1).max(2000),
    note: z.string().max(500).optional(),
  })
  .strict();
export type UnmappedClause = z.infer<typeof unmappedClauseSchema>;

/**
 * THE COMPILED AP RULESET — the whole machine-readable bill-approval policy. Persisted
 * as `ap_approval_policies.compiled_rules` (jsonb), validated against this schema on
 * every read and write. A missing/optional field means "no rule", so the empty ruleset
 * (`DEFAULT_AP_RULESET`) is a valid, fully NON-BLOCKING policy.
 */
export const apPolicyRulesetSchema = z
  .object({
    schemaVersion: z.literal(AP_RULESET_SCHEMA_VERSION).default(AP_RULESET_SCHEMA_VERSION),
    currency: z.string().length(3).default('USD'),

    vendors: z.array(vendorRuleSchema).max(1000).default([]),
    categories: z.array(categoryRuleSchema).max(500).default([]),

    /** Amount-tiered approval routing (by bill total). */
    approvalTiers: z.array(approvalTierSchema).max(20).default([]),

    /** Absolute per-bill ceiling regardless of vendor/category (cents). null = none. */
    perBillCeilingCents: cents.nullable().default(null),
    perBillCeilingSeverity: ruleSeveritySchema.default('BLOCK'),

    /** A purchase order is required once the bill total reaches this (cents). null = never. */
    requirePoOverCents: cents.nullable().default(null),
    requirePoSeverity: ruleSeveritySchema.default('BLOCK'),

    /** A CLEAN 3-way match is required once the bill total reaches this (cents). null = never. */
    requireThreeWayMatchOverCents: cents.nullable().default(null),
    threeWayMatchSeverity: ruleSeveritySchema.default('BLOCK'),

    /** Block suspected duplicate bills (same vendor + bill number + amount). */
    duplicateBillBlock: z.boolean().default(false),
    duplicateBillSeverity: ruleSeveritySchema.default('BLOCK'),

    unmappedClauses: z.array(unmappedClauseSchema).max(300).default([]),

    /** A short human summary of the source document (for the review screen). */
    sourceSummary: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type ApPolicyRuleset = z.infer<typeof apPolicyRulesetSchema>;

/**
 * The conservative default when NO policy is ACTIVE: an empty, fully non-blocking
 * ruleset. The engine yields zero violations and a null tier against it, so the AP
 * flow degrades safely — nothing is blocked, nothing breaks.
 */
export const DEFAULT_AP_RULESET: ApPolicyRuleset = apPolicyRulesetSchema.parse({});

/** Canonical GL/category tokens the compiler prefers (extensible — not exhaustive). */
export const CANONICAL_AP_CATEGORY_TOKENS = [
  'MATERIALS',
  'SUBCONTRACTOR',
  'EQUIPMENT',
  'PROFESSIONAL_SERVICES',
  'SOFTWARE',
  'UTILITIES',
  'RENT',
  'INSURANCE',
  'TRAVEL',
  'MARKETING',
  'CAPEX',
  'OTHER',
] as const;

/**
 * Validate an unknown value as an AP ruleset. Thin wrapper over the shared parser so
 * routes/loaders have a single import surface. A malformed blob can never enforce.
 */
export function parseApRuleset(
  input: unknown
): { ok: true; ruleset: ApPolicyRuleset } | { ok: false; errors: string[] } {
  const res = apPolicyRulesetSchema.safeParse(input);
  if (res.success) return { ok: true, ruleset: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
