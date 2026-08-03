/**
 * THE REUSABLE POLICY PRIMITIVE — the domain-agnostic spine of "drop a written
 * policy, get a schema-validated ruleset a human approves, a deterministic engine
 * enforces."
 *
 * It was factored out of the just-built EXPENSE policy engine (lib/expenses/*) so a
 * second domain (AP / bill approval) — and any future one (payroll, POs, travel) —
 * shares the SAME lifecycle without copy-paste and without re-litigating the safety
 * boundary. `lib/expenses` keeps working unchanged; new domains build on this.
 *
 * SAFETY BOUNDARY (canon — this is a fintech book of record):
 *   1. CONFIG, NOT CODEGEN. The AI compiler runs THROUGH the Core AI gateway
 *      (`@meritbooks/core-ai`, metered to core.ai_usage_log, tenant budget enforced
 *      across the combined suite) and returns LOOSE JSON — field values only, never
 *      code/SQL/logic. Those values are run through a PURE, per-domain normalizer and
 *      validated against a FIXED Zod schema. Anything the schema can't express is kept
 *      verbatim for a human. The deterministic engine reads ONLY the validated shape.
 *   2. PROPOSE ONLY. The compiler emits DATA + an audit row; nothing enforces until a
 *      human ACTIVATES a version through the gated create/activate path.
 *   3. DEGRADE-SAFE. No active policy / missing table / corrupt blob → the loader
 *      returns null and the caller falls back to a conservative, non-blocking default.
 *
 * Money is bigint cents everywhere (canon). RLS scopes every read/write to the org.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { runAiGateway } from '@meritbooks/core-ai';

// ---------------------------------------------------------------------------
// Domain configuration — a policy domain is fully described by this object.
// ---------------------------------------------------------------------------

/**
 * Everything the shared lifecycle needs to serve ONE policy domain. `expenses` and
 * `ap` each supply one of these; the store/compile helpers below are otherwise
 * identical across domains.
 */
export interface PolicyDomainConfig<TRuleset> {
  /** Stable domain token, for logs/metering (e.g. 'AP', 'EXPENSE'). */
  domain: string;
  /** The `public` table holding the versioned compiled rulesets. */
  table: string;
  /** The fixed Zod schema the compiled ruleset MUST validate against. The Input
   * generic is `unknown` so schemas whose `.default()`s make some inputs optional
   * (optional-in / required-out) still satisfy the required output ruleset. */
  schema: z.ZodType<TRuleset, z.ZodTypeDef, unknown>;
  /** Conservative, fully non-blocking ruleset used when nothing is active. */
  defaultRuleset: TRuleset;
  /** Core-AI gateway feature id (metered) for the drop-and-compile call. */
  extractFeature: string;
  /** Model the gateway should use for extraction. */
  extractModel: string;
}

// ---------------------------------------------------------------------------
// Validation (shared)
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a ruleset for a domain. Returns the parsed ruleset or
 * human-readable errors. Used by every read (loader) and write (create/activate) so a
 * malformed/hand-tampered `compiled_rules` blob can NEVER reach enforcement.
 */
export function parsePolicyRuleset<TRuleset>(
  schema: z.ZodType<TRuleset, z.ZodTypeDef, unknown>,
  input: unknown
): { ok: true; ruleset: TRuleset } | { ok: false; errors: string[] } {
  const res = schema.safeParse(input);
  if (res.success) return { ok: true, ruleset: res.data };
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

// ---------------------------------------------------------------------------
// Store — load the single ACTIVE compiled ruleset for an org (degrade-safe)
// ---------------------------------------------------------------------------

export interface ActivePolicy<TRuleset> {
  policyId: string;
  name: string;
  version: number;
  ruleset: TRuleset;
}

/**
 * Fetch the one ACTIVE policy row for an org and validate its `compiled_rules` before
 * it can drive enforcement. DEGRADE-SAFE: no active policy, the table doesn't exist
 * yet, the query errors, or the stored blob fails validation → returns `null` and the
 * caller falls back to the conservative default. A corrupt policy can never block flow.
 */
export async function loadActivePolicy<TRuleset>(
  db: SupabaseClient,
  cfg: PolicyDomainConfig<TRuleset>,
  orgId: string
): Promise<ActivePolicy<TRuleset> | null> {
  try {
    const { data, error } = await db
      .from(cfg.table)
      .select('id, name, version, compiled_rules')
      .eq('org_id', orgId)
      .eq('status', 'ACTIVE')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as { id: string; name: string; version: number; compiled_rules: unknown };
    const parsed = parsePolicyRuleset(cfg.schema, row.compiled_rules);
    if (!parsed.ok) {
      console.error(`[policy:${cfg.domain}] active policy failed schema validation:`, parsed.errors.join('; '));
      return null;
    }
    return { policyId: row.id, name: row.name, version: row.version, ruleset: parsed.ruleset };
  } catch (e) {
    // Table may not exist yet (migration not applied) — degrade to no policy.
    console.error(`[policy:${cfg.domain}] loadActivePolicy failed (non-fatal):`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic evaluator interface — the shared contract every engine honors.
// ---------------------------------------------------------------------------

/** WARN = advisory (surfaced to the approver); BLOCK = a hard stop (needs override). */
export type PolicySeverity = 'WARN' | 'BLOCK';

/**
 * A pure, side-effect-free evaluator: (subject, ruleset) → deterministic result. This
 * is the hand-written, auditable code the AI is deliberately kept away from — the AI
 * only ever produces the ruleset DATA; an evaluator of this shape is the only thing
 * that acts on a transaction.
 */
export type PolicyEvaluator<TSubject, TRuleset, TResult> = (
  subject: TSubject,
  ruleset: TRuleset
) => TResult;

/**
 * Select an amount tier. Tiers are sorted ascending by `uptoCents` (null — the
 * catch-all — last); the first whose inclusive bound covers the amount wins. No tiers
 * → null. Shared by every domain that routes approval by amount. Pure.
 */
export function pickAmountTier(
  amountCents: number,
  tiers: ReadonlyArray<{ uptoCents: number | null; tier: string }>
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
// Compile — drop a document, get a proposed ruleset THROUGH the metered gateway.
// ---------------------------------------------------------------------------

export type CompilePolicyResult<TRuleset> =
  | {
      ok: true;
      ruleset: TRuleset;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Compile an uploaded policy document into a proposed ruleset for a domain, THROUGH
 * the Core AI gateway (metered, budget-capped per tenant). Accepts base64 PDF/image.
 * The per-domain `extractionPrompt` and pure `normalize` are supplied by the caller;
 * this function owns only the safety-critical plumbing (gateway call, JSON parse,
 * schema-validated normalize). Never throws for expected failures — returns
 * `{ ok: false, ... }` so the route degrades cleanly.
 */
export async function compilePolicyDocument<TRuleset>(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  cfg: PolicyDomainConfig<TRuleset> & {
    extractionPrompt: string;
    /** PURE, gateway-free normalizer: loose model JSON → validated ruleset. */
    normalize: (raw: unknown) => { ruleset: TRuleset; documentNote: string | null };
  },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string }
): Promise<CompilePolicyResult<TRuleset>> {
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
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data },
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
        feature: cfg.extractFeature,
        model: cfg.extractModel,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: cfg.extractionPrompt }] }],
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
    console.error(`[policy:${cfg.domain}-compile] Failed to parse model JSON:`, jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const { ruleset, documentNote } = cfg.normalize(parsed);

  return {
    ok: true,
    ruleset,
    model: gw.model_used ?? cfg.extractModel,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}

// ---------------------------------------------------------------------------
// Small shared normalizer helpers (pure) — reused by every domain's normalizer.
// ---------------------------------------------------------------------------

/** Model reports WHOLE DOLLARS for money fields; convert to integer cents (>= 0). */
export function dollarsToCentsOrNull(raw: unknown): number | null {
  const dollars = toDollarsNumber(raw);
  if (dollars === null) return null;
  return Math.round(dollars * 100);
}

export function toDollarsNumber(raw: unknown): number | null {
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

export function toBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return ['true', 'yes', '1', 'y'].includes(raw.trim().toLowerCase());
  return false;
}

export function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

export function toSeverity(raw: unknown, fallback: PolicySeverity): PolicySeverity {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s === 'BLOCK' || s === 'HARD' || s === 'DENY' || s === 'PROHIBIT') return 'BLOCK';
    if (s === 'WARN' || s === 'SOFT' || s === 'FLAG' || s === 'ADVISORY') return 'WARN';
  }
  return fallback;
}

/** UPPER_SNAKE-case a free-text name into a stable token. */
export function toToken(raw: unknown, fallback = 'OTHER'): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return fallback;
  return (
    s
      .toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || fallback
  );
}
