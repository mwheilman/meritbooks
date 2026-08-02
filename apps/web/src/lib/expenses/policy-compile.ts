/**
 * THE EXPENSE-POLICY COMPILER — drop a written expense policy, get a structured,
 * schema-validated ruleset a human then reviews and activates.
 *
 * CONFIG, NOT CODEGEN (hard safety boundary): the model runs THROUGH the Core AI
 * gateway (`@meritbooks/core-ai`, feature EXPENSE_POLICY_EXTRACT, metered to
 * core.ai_usage_log, tenant budget enforced across the combined suite) and returns
 * loose JSON. It NEVER produces code, SQL, or logic — only field values. Those
 * values are run through the PURE `normalizePolicyExtraction` and validated against
 * the fixed `expensePolicyRulesetSchema`. Anything the model flags as unmapped, or
 * any clause the schema can't express, is captured verbatim in `unmappedClauses`
 * for a human — never invented into behavior.
 *
 * PROPOSE ONLY (canon §3): the parse route logs a single `ai_decisions` PROPOSED
 * row and returns the ruleset for review. NOTHING is enforced until a human
 * activates a policy via the gated create/activate path.
 *
 * `normalizePolicyExtraction` is exported and unit-tested with NO gateway
 * dependency — it is the deterministic heart of the compiler.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import {
  expensePolicyRulesetSchema,
  type ExpensePolicyRuleset,
  type CategoryRule,
  type RuleSeverity,
  DEFAULT_RULESET,
  RULESET_SCHEMA_VERSION,
} from './policy-schema';

export const EXPENSE_POLICY_EXTRACT_FEATURE = 'EXPENSE_POLICY_EXTRACT';
export const EXPENSE_POLICY_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

export type CompilePolicyResult =
  | {
      ok: true;
      ruleset: ExpensePolicyRuleset;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

// ---------------------------------------------------------------------------
// Pure normalizer (no gateway, no DB) — unit-tested
// ---------------------------------------------------------------------------

function toIntCentsOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let n: number | null = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    n = Number.isFinite(parsed) ? parsed : null;
  }
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Model reports DOLLARS for limits; convert to integer cents. Rejects negatives. */
function dollarsToCentsOrNull(raw: unknown): number | null {
  const dollars = toDollarsNumber(raw);
  if (dollars === null) return null;
  return Math.round(dollars * 100);
}

function toDollarsNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function toBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['true', 'yes', '1', 'y'].includes(raw.trim().toLowerCase());
  return false;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

function toSeverity(raw: unknown, fallback: RuleSeverity): RuleSeverity {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s === 'BLOCK' || s === 'HARD' || s === 'DENY' || s === 'PROHIBIT') return 'BLOCK';
    if (s === 'WARN' || s === 'SOFT' || s === 'FLAG' || s === 'ADVISORY') return 'WARN';
  }
  return fallback;
}

/** UPPER_SNAKE-case a free-text category name into a stable token. */
export function toCategoryToken(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'OTHER';
  return (
    s
      .toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'OTHER'
  );
}

interface RawCategory {
  category?: unknown;
  name?: unknown;
  label?: unknown;
  keywords?: unknown;
  per_expense_limit?: unknown;
  per_day_limit?: unknown;
  per_trip_limit?: unknown;
  prohibited?: unknown;
  pre_approval_required?: unknown;
  severity?: unknown;
}

function normalizeCategory(rc: RawCategory): CategoryRule | null {
  if (rc == null || typeof rc !== 'object') return null;
  const category = toCategoryToken(rc.category ?? rc.name ?? rc.label);
  const label = toStringOrNull(rc.label) ?? toStringOrNull(rc.name) ?? undefined;
  const keywords = Array.isArray(rc.keywords)
    ? (rc.keywords as unknown[])
        .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
        .filter((k): k is string => k.length > 0)
        .slice(0, 50)
    : [];

  return {
    category,
    label,
    matchAccountIds: [],
    matchKeywords: keywords,
    perExpenseLimitCents: dollarsToCentsOrNull(rc.per_expense_limit),
    perDayLimitCents: dollarsToCentsOrNull(rc.per_day_limit),
    perTripLimitCents: dollarsToCentsOrNull(rc.per_trip_limit),
    prohibited: toBool(rc.prohibited),
    preApprovalRequired: toBool(rc.pre_approval_required),
    severity: toSeverity(rc.severity, 'BLOCK'),
  };
}

interface RawRoot {
  categories?: unknown;
  receipt_required_over?: unknown;
  per_expense_ceiling?: unknown;
  per_diem?: {
    enabled?: unknown;
    default_daily?: unknown;
    applies_to?: unknown;
    by_location?: unknown;
  };
  mileage_rate_cents_per_mile?: unknown;
  mileage_rate_dollars_per_mile?: unknown;
  alcohol_cap?: unknown;
  entertainment_cap?: unknown;
  approval_tiers?: unknown;
  unmapped_clauses?: unknown;
  source_summary?: unknown;
  document_note?: unknown;
}

/**
 * Turn the model's loose JSON into a VALIDATED ruleset. Never throws — a shape the
 * schema rejects degrades to the conservative default with the whole payload noted
 * as an unmapped clause (so nothing is silently lost, and nothing bogus enforces).
 *
 * `documentNote` is returned separately (it's about the extraction, not the policy).
 */
export function normalizePolicyExtraction(
  raw: unknown
): { ruleset: ExpensePolicyRuleset; documentNote: string | null } {
  const root = (raw ?? {}) as RawRoot;
  const documentNote =
    raw && typeof raw === 'object' ? toStringOrNull((raw as RawRoot).document_note) : null;

  // Categories.
  const rawCats = Array.isArray(root.categories) ? (root.categories as RawCategory[]) : [];
  const categories = rawCats
    .map(normalizeCategory)
    .filter((c): c is CategoryRule => c !== null);

  // Unmapped clauses — the human-handling escape hatch.
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

  // Per-diem.
  const pd = root.per_diem ?? {};
  const byLocation = Array.isArray(pd.by_location)
    ? (pd.by_location as unknown[])
        .map((l) => {
          if (!l || typeof l !== 'object') return null;
          const location = toStringOrNull((l as { location?: unknown }).location);
          const dailyCents = dollarsToCentsOrNull((l as { daily?: unknown }).daily);
          if (!location || dailyCents === null) return null;
          return { location, dailyCents };
        })
        .filter((x): x is { location: string; dailyCents: number } => x !== null)
        .slice(0, 1000)
    : [];
  const appliesTo = Array.isArray(pd.applies_to)
    ? (pd.applies_to as unknown[])
        .map((c) => toCategoryToken(c))
        .filter((c) => c && c !== 'OTHER')
        .slice(0, 50)
    : [];
  const pdDefault = dollarsToCentsOrNull(pd.default_daily);
  const perDiemEnabled = toBool(pd.enabled) || pdDefault !== null || byLocation.length > 0;

  // Approval tiers.
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

  // Mileage — accept an integer cents/mile or a dollars/mile the model provides.
  let mileageRateCentsPerMile: number | null = toIntCentsOrNull(root.mileage_rate_cents_per_mile);
  if (mileageRateCentsPerMile === null) {
    const dollars = toDollarsNumber(root.mileage_rate_dollars_per_mile);
    if (dollars !== null) mileageRateCentsPerMile = Math.round(dollars * 100);
  }

  const candidate = {
    schemaVersion: RULESET_SCHEMA_VERSION,
    currency: 'USD',
    categories,
    receiptRequiredOverCents: dollarsToCentsOrNull(root.receipt_required_over),
    receiptRuleSeverity: 'WARN' as RuleSeverity,
    perExpenseCeilingCents: dollarsToCentsOrNull(root.per_expense_ceiling),
    perExpenseCeilingSeverity: 'BLOCK' as RuleSeverity,
    perDiem: {
      enabled: perDiemEnabled,
      defaultDailyCents: pdDefault,
      byLocation,
      appliesToCategories: appliesTo.length > 0 ? appliesTo : perDiemEnabled ? ['MEALS', 'LODGING'] : [],
      severity: 'WARN' as RuleSeverity,
    },
    mileageRateCentsPerMile,
    alcoholCapCents: dollarsToCentsOrNull(root.alcohol_cap),
    entertainmentCapCents: dollarsToCentsOrNull(root.entertainment_cap),
    discretionaryCapSeverity: 'WARN' as RuleSeverity,
    approvalTiers,
    unmappedClauses,
    sourceSummary: toStringOrNull(root.source_summary),
  };

  const parsed = expensePolicyRulesetSchema.safeParse(candidate);
  if (parsed.success) return { ruleset: parsed.data, documentNote };

  // Defensive fallback: never let a malformed shape enforce. Preserve what we saw.
  const fallback: ExpensePolicyRuleset = {
    ...DEFAULT_RULESET,
    unmappedClauses: [
      {
        text: 'The policy document could not be compiled into the structured ruleset. Enter the rules manually.',
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
// The gateway call
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert corporate controller. Read this company EXPENSE POLICY document and translate it into a STRUCTURED ruleset.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "categories": [
    {
      "category": "short UPPER_SNAKE token, e.g. MEALS, LODGING, AIRFARE, ALCOHOL, ENTERTAINMENT",
      "label": "human label as written in the policy",
      "keywords": ["lowercase words that identify this category on a receipt/merchant, e.g. hotel, restaurant"],
      "per_expense_limit": number or null (WHOLE DOLLARS, per single expense),
      "per_day_limit": number or null (WHOLE DOLLARS, per day),
      "per_trip_limit": number or null (WHOLE DOLLARS, per trip/report),
      "prohibited": true/false (the policy forbids expensing this),
      "pre_approval_required": true/false,
      "severity": "WARN | BLOCK — BLOCK if the policy makes it a hard rule, WARN if it's guidance"
    }
  ],
  "receipt_required_over": number or null (WHOLE DOLLARS — receipts required at/above this),
  "per_expense_ceiling": number or null (WHOLE DOLLARS — absolute cap on any single expense),
  "per_diem": {
    "enabled": true/false,
    "default_daily": number or null (WHOLE DOLLARS/day),
    "applies_to": ["category tokens the per-diem covers, e.g. MEALS, LODGING"],
    "by_location": [{ "location": "city/region", "daily": number (WHOLE DOLLARS/day) }]
  },
  "mileage_rate_dollars_per_mile": number or null (e.g. 0.67),
  "alcohol_cap": number or null (WHOLE DOLLARS — cap on a single alcohol expense),
  "entertainment_cap": number or null (WHOLE DOLLARS — cap on a single entertainment expense),
  "approval_tiers": [
    { "upto": number or null (WHOLE DOLLARS inclusive upper bound; null = everything above), "tier": "role that must approve, e.g. MANAGER / DIRECTOR / CFO" }
  ],
  "unmapped_clauses": [
    { "text": "verbatim clause you could NOT express in the fields above", "note": "why it doesn't fit" }
  ],
  "source_summary": "one or two sentences describing the policy",
  "document_note": "anything unusual (scanned/illegible, draft, no policy found) or null"
}

CRITICAL RULES:
- Output DATA ONLY. Never output code, formulas, or instructions — only the field values above.
- All money amounts are WHOLE DOLLARS, never cents.
- If a clause does NOT fit any field (e.g. "submit within 30 days", "no first-class airfare without VP sign-off"), DO NOT force it — put it verbatim in "unmapped_clauses". It is safer to leave a rule for a human than to guess.
- If a value is not stated, use null. NEVER invent limits.
- If the document is not an expense policy, return empty categories and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Compile an uploaded expense-policy document into a proposed ruleset THROUGH the
 * Core AI gateway (metered, budget-capped per tenant). Accepts base64 PDF/image.
 * Never throws for expected failures — returns `{ ok: false, ... }` so the route
 * degrades cleanly.
 */
export async function compileExpensePolicyDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string }
): Promise<CompilePolicyResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mediaType}. Must be PDF or image.` };
  }

  const contentBlock = isPdf
    ? {
        type: 'document' as const,
        source: {
          type: 'base64' as const,
          media_type: 'application/pdf' as const,
          data: base64Data,
        },
      }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: base64Data,
        },
      };

  let gw;
  try {
    gw = await runAiGateway(
      { supabase, anthropicApiKey },
      {
        tenant_id: orgId,
        user_id: userId ?? null,
        module: 'BOOKS',
        feature: EXPENSE_POLICY_EXTRACT_FEATURE,
        model: EXPENSE_POLICY_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 4000,
      }
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error' };
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };
  }

  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Model returned an empty response' };

  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[expense-policy-compile] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const { ruleset, documentNote } = normalizePolicyExtraction(parsed);

  return {
    ok: true,
    ruleset,
    model: gw.model_used ?? EXPENSE_POLICY_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
