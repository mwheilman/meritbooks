/**
 * THE AP-POLICY COMPILER — drop a written bill-approval / accounts-payable policy, get
 * a structured, schema-validated ruleset a human then reviews and activates.
 *
 * CONFIG, NOT CODEGEN (hard safety boundary): the model runs THROUGH the Core AI gateway
 * (`@meritbooks/core-ai`, feature AP_POLICY_EXTRACT, metered to core.ai_usage_log, tenant
 * budget enforced across the combined suite) and returns loose JSON. It NEVER produces
 * code, SQL, or logic — only field values. Those values are run through the PURE
 * `normalizeApPolicyExtraction` and validated against the fixed `apPolicyRulesetSchema`.
 * Anything the model flags as unmapped, or any clause the schema can't express, is
 * captured verbatim in `unmappedClauses` for a human — never invented into behavior.
 *
 * PROPOSE ONLY (canon §3): the parse route logs a single `ai_decisions` PROPOSED row and
 * returns the ruleset for review. NOTHING enforces until a human activates a version.
 *
 * `normalizeApPolicyExtraction` is exported and unit-testable with NO gateway dependency.
 * The gateway plumbing itself lives in the shared `compilePolicyDocument` (lib/policy/core).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  compilePolicyDocument,
  dollarsToCentsOrNull,
  toBool,
  toStringOrNull,
  toSeverity,
  toToken,
  type CompilePolicyResult,
  type PolicySeverity,
} from './core';
import {
  apPolicyRulesetSchema,
  AP_RULESET_SCHEMA_VERSION,
  DEFAULT_AP_RULESET,
  type ApPolicyRuleset,
  type VendorRule,
  type CategoryRule,
} from './ap-schema';

export const AP_POLICY_EXTRACT_FEATURE = 'AP_POLICY_EXTRACT';
export const AP_POLICY_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Pure normalizer (no gateway, no DB) — unit-tested
// ---------------------------------------------------------------------------

interface RawVendor {
  vendor?: unknown;
  name?: unknown;
  label?: unknown;
  keywords?: unknown;
  prohibited?: unknown;
  per_bill_limit?: unknown;
  severity?: unknown;
}

function normalizeVendor(rv: RawVendor): VendorRule | null {
  if (rv == null || typeof rv !== 'object') return null;
  const label = toStringOrNull(rv.label) ?? toStringOrNull(rv.name) ?? toStringOrNull(rv.vendor) ?? undefined;
  const keywords = Array.isArray(rv.keywords)
    ? (rv.keywords as unknown[])
        .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
        .filter((k): k is string => k.length > 0)
        .slice(0, 50)
    : [];
  // Seed a keyword from the vendor/name so a name-only rule still matches.
  const seed = toStringOrNull(rv.name) ?? toStringOrNull(rv.vendor);
  if (seed && !keywords.includes(seed.toLowerCase())) keywords.unshift(seed.toLowerCase());
  if (keywords.length === 0 && !label) return null;

  return {
    label,
    matchVendorId: null,
    matchKeywords: keywords.slice(0, 50),
    prohibited: toBool(rv.prohibited),
    perBillLimitCents: dollarsToCentsOrNull(rv.per_bill_limit),
    severity: toSeverity(rv.severity, 'BLOCK'),
  };
}

interface RawCategory {
  category?: unknown;
  name?: unknown;
  label?: unknown;
  keywords?: unknown;
  account_numbers?: unknown;
  per_line_limit?: unknown;
  per_bill_limit?: unknown;
  prohibited?: unknown;
  severity?: unknown;
}

function normalizeCategory(rc: RawCategory): CategoryRule | null {
  if (rc == null || typeof rc !== 'object') return null;
  const category = toToken(rc.category ?? rc.name ?? rc.label);
  const label = toStringOrNull(rc.label) ?? toStringOrNull(rc.name) ?? undefined;
  const keywords = Array.isArray(rc.keywords)
    ? (rc.keywords as unknown[])
        .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
        .filter((k): k is string => k.length > 0)
        .slice(0, 50)
    : [];
  const accountNumbers = Array.isArray(rc.account_numbers)
    ? (rc.account_numbers as unknown[])
        .map((n) => (typeof n === 'string' ? n.trim() : typeof n === 'number' ? String(n) : ''))
        .filter((n): n is string => n.length > 0)
        .slice(0, 500)
    : [];

  return {
    category,
    label,
    matchAccountIds: [],
    matchAccountNumbers: accountNumbers,
    matchKeywords: keywords,
    perLineLimitCents: dollarsToCentsOrNull(rc.per_line_limit),
    perBillLimitCents: dollarsToCentsOrNull(rc.per_bill_limit),
    prohibited: toBool(rc.prohibited),
    severity: toSeverity(rc.severity, 'BLOCK'),
  };
}

interface RawRoot {
  vendors?: unknown;
  categories?: unknown;
  approval_tiers?: unknown;
  per_bill_ceiling?: unknown;
  require_po_over?: unknown;
  require_three_way_match_over?: unknown;
  duplicate_bill_block?: unknown;
  unmapped_clauses?: unknown;
  source_summary?: unknown;
  document_note?: unknown;
}

/**
 * Turn the model's loose JSON into a VALIDATED AP ruleset. Never throws — a shape the
 * schema rejects degrades to the conservative default with the payload noted as an
 * unmapped clause (nothing silently lost, nothing bogus enforced).
 */
export function normalizeApPolicyExtraction(
  raw: unknown
): { ruleset: ApPolicyRuleset; documentNote: string | null } {
  const root = (raw ?? {}) as RawRoot;
  const documentNote =
    raw && typeof raw === 'object' ? toStringOrNull((raw as RawRoot).document_note) : null;

  const vendors = Array.isArray(root.vendors)
    ? (root.vendors as RawVendor[]).map(normalizeVendor).filter((v): v is VendorRule => v !== null)
    : [];

  const categories = Array.isArray(root.categories)
    ? (root.categories as RawCategory[]).map(normalizeCategory).filter((c): c is CategoryRule => c !== null)
    : [];

  const approvalTiers: { uptoCents: number | null; tier: string }[] = [];
  if (Array.isArray(root.approval_tiers)) {
    for (const t of root.approval_tiers as unknown[]) {
      if (!t || typeof t !== 'object') continue;
      const tier = toStringOrNull((t as { tier?: unknown }).tier);
      if (!tier) continue;
      const rawUpto = (t as { upto?: unknown }).upto;
      const uptoCents =
        rawUpto === null || rawUpto === undefined || rawUpto === '' || String(rawUpto).toLowerCase() === 'null'
          ? null
          : dollarsToCentsOrNull(rawUpto);
      approvalTiers.push({ uptoCents, tier: tier.slice(0, 60) });
    }
  }

  const unmappedClauses: { text: string; note?: string }[] = [];
  if (Array.isArray(root.unmapped_clauses)) {
    for (const u of root.unmapped_clauses as unknown[]) {
      if (typeof u === 'string') {
        const t = u.trim();
        if (t) unmappedClauses.push({ text: t.slice(0, 2000) });
      } else if (u && typeof u === 'object') {
        const text = toStringOrNull((u as { text?: unknown }).text);
        const note = toStringOrNull((u as { note?: unknown }).note);
        if (text) unmappedClauses.push({ text: text.slice(0, 2000), note: note ?? undefined });
      }
    }
  }

  const candidate = {
    schemaVersion: AP_RULESET_SCHEMA_VERSION,
    currency: 'USD',
    vendors,
    categories,
    approvalTiers,
    perBillCeilingCents: dollarsToCentsOrNull(root.per_bill_ceiling),
    perBillCeilingSeverity: 'BLOCK' as PolicySeverity,
    requirePoOverCents: dollarsToCentsOrNull(root.require_po_over),
    requirePoSeverity: 'BLOCK' as PolicySeverity,
    requireThreeWayMatchOverCents: dollarsToCentsOrNull(root.require_three_way_match_over),
    threeWayMatchSeverity: 'BLOCK' as PolicySeverity,
    duplicateBillBlock: toBool(root.duplicate_bill_block),
    duplicateBillSeverity: 'BLOCK' as PolicySeverity,
    unmappedClauses,
    sourceSummary: toStringOrNull(root.source_summary),
  };

  const parsed = apPolicyRulesetSchema.safeParse(candidate);
  if (parsed.success) return { ruleset: parsed.data, documentNote };

  const fallback: ApPolicyRuleset = {
    ...DEFAULT_AP_RULESET,
    unmappedClauses: [
      {
        text: 'The AP policy document could not be compiled into the structured ruleset. Enter the rules manually.',
        note: parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      },
      ...unmappedClauses,
    ].slice(0, 300),
  };
  return { ruleset: fallback, documentNote };
}

// ---------------------------------------------------------------------------
// The gateway call (via the shared primitive)
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert accounts-payable controller. Read this company BILL-APPROVAL / ACCOUNTS-PAYABLE policy document and translate it into a STRUCTURED ruleset.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "vendors": [
    {
      "name": "vendor name as written in the policy",
      "keywords": ["lowercase words that identify this vendor on a bill"],
      "prohibited": true/false (bills to this vendor are not allowed),
      "per_bill_limit": number or null (WHOLE DOLLARS, cap on a single bill for this vendor),
      "severity": "WARN | BLOCK"
    }
  ],
  "categories": [
    {
      "category": "short UPPER_SNAKE token, e.g. SUBCONTRACTOR, MATERIALS, SOFTWARE, PROFESSIONAL_SERVICES",
      "label": "human label as written",
      "keywords": ["lowercase words that identify this GL category on a bill line"],
      "account_numbers": ["GL account numbers that map to this category, if the policy names them"],
      "per_line_limit": number or null (WHOLE DOLLARS, cap on a single bill LINE),
      "per_bill_limit": number or null (WHOLE DOLLARS, cap on this category's TOTAL on one bill),
      "prohibited": true/false,
      "severity": "WARN | BLOCK"
    }
  ],
  "approval_tiers": [
    { "upto": number or null (WHOLE DOLLARS inclusive upper bound; null = everything above), "tier": "role that must approve, e.g. MANAGER / CONTROLLER / CFO" }
  ],
  "per_bill_ceiling": number or null (WHOLE DOLLARS — absolute cap on any single bill),
  "require_po_over": number or null (WHOLE DOLLARS — a purchase order is required at/above this bill total),
  "require_three_way_match_over": number or null (WHOLE DOLLARS — a clean 3-way match is required at/above this),
  "duplicate_bill_block": true/false (block suspected duplicate bills),
  "unmapped_clauses": [
    { "text": "verbatim clause you could NOT express in the fields above", "note": "why it doesn't fit" }
  ],
  "source_summary": "one or two sentences describing the policy",
  "document_note": "anything unusual (scanned/illegible, draft, no policy found) or null"
}

CRITICAL RULES:
- Output DATA ONLY. Never output code, formulas, or instructions — only the field values above.
- All money amounts are WHOLE DOLLARS, never cents.
- If a clause does NOT fit any field (e.g. "segregate invoice entry from approval", "W-9 on file before first payment"), DO NOT force it — put it verbatim in "unmapped_clauses". It is safer to leave a rule for a human than to guess.
- If a value is not stated, use null. NEVER invent limits or thresholds.
- If the document is not an AP/bill-approval policy, return empty vendors/categories and explain in document_note.`;

/**
 * Compile an uploaded AP-policy document into a proposed ruleset THROUGH the Core AI
 * gateway (metered, budget-capped per tenant). Accepts base64 PDF/image. Delegates all
 * safety-critical plumbing to `compilePolicyDocument`; supplies only the AP prompt +
 * pure normalizer. Never throws for expected failures.
 */
export async function compileApPolicyDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string }
): Promise<CompilePolicyResult<ApPolicyRuleset>> {
  return compilePolicyDocument(
    deps,
    {
      domain: 'AP',
      table: 'ap_approval_policies',
      schema: apPolicyRulesetSchema,
      defaultRuleset: DEFAULT_AP_RULESET,
      extractFeature: AP_POLICY_EXTRACT_FEATURE,
      extractModel: AP_POLICY_EXTRACT_MODEL,
      extractionPrompt: EXTRACTION_PROMPT,
      normalize: normalizeApPolicyExtraction,
    },
    args
  );
}
