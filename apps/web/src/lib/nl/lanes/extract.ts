/**
 * Universal NL Command — PROCESSING lane structured extractors (P2/P3/P4).
 *
 * These helpers are ISOMORPHIC and dependency-free (no next/clerk/db/gateway).
 * Each lane turns a plain-English prompt into a typed DRAFT proposal by calling
 * an INJECTED model function (`LaneModelCall`) and parsing/validating its JSON.
 * The gateway lives in the route (app/api/nl/*); injecting the call is what makes
 * every extractor unit-testable with a mocked gateway.
 *
 * Canon invariant (FPB-nl-copilot §1): a processing prompt yields a *proposed
 * fact*, never a posted one, and — on a missing/ambiguous required field — asks
 * ONE clarifying question rather than guessing (clarify-before-book). The route
 * then resolves the draft to real ids, writes an `ai_decisions` PROPOSED row, and
 * routes approval through the host feature's existing gated route.
 */

/** The injected model call: takes the composed user text, returns raw model text. */
export type LaneModelCall = (userText: string) => Promise<string>;

/**
 * The uniform shape every extractor returns. `draft` is null whenever we must
 * clarify (a required field is missing/ambiguous) or the model failed to parse —
 * fail closed, never fabricate.
 */
export interface LaneExtraction<T> {
  draft: T | null;
  clarifyingQuestion: string | null;
  confidence: number;
  /** Raw parsed model object, kept for the audit trail / debugging. */
  raw: Record<string, unknown> | null;
}

/** Strip markdown fences and parse loosely; returns null on any failure. */
export function parseLooseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // Grab the outermost { … } so trailing prose never breaks the parse.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce a model money value (dollars, "$1,200", or a cents integer) → cents. */
export function toCents(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // A whole number >= 1000 with no decimal is almost certainly already cents
    // ONLY when the model was told to send cents — our prompts request cents, so
    // trust an integer as cents.
    return Math.round(value);
  }
  const s = String(value).replace(/[$,\s]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // A decimal string ("1200.00") is dollars; an integer string is treated as cents.
  return /[.]/.test(s) ? Math.round(n * 100) : Math.round(n);
}

/** Nullable trimmed string. */
export function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

/** ISO date passthrough (YYYY-MM-DD) or null. */
export function isoDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Clamp a 0..1 confidence. */
export function conf(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
