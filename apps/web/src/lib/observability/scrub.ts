/**
 * Secret scrubbing + stable error fingerprinting for the observability layer.
 *
 * Pure, dependency-free, and unit-tested. This is a book of record on a fintech
 * spine: NOTHING that reaches `public.app_error_log` (or a Sentry forwarder) may
 * carry a live credential, so every message / stack / meta value is passed through
 * `scrubString` / `scrubMeta` first.
 *
 * `digestFor()` produces a STABLE fingerprint (an 8-char hex hash) so the same
 * error raised across a thousand requests collapses into ONE grouped row-with-a-
 * count on the ops-health dashboard instead of a thousand near-duplicate lines.
 */

export const REDACTED = '[REDACTED]';

// Object keys whose *values* are secrets, matched case-insensitively. Used by
// scrubMeta to blank a value regardless of its shape.
const SECRET_KEY_RE =
  /(authorization|set-?cookie|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|client[-_]?secret|private[-_]?key|service[-_]?role|bearer|session)/i;

// key=value / key: value / "key":"value" pairs (in free text like a stack or a
// serialized header dump) whose KEY names a secret → redact the VALUE. Groups:
//   $1 = "key<sep>"  $2 = optional opening quote (kept so JSON stays parseable)
const KV_SECRET_RE = new RegExp(
  '((?:authorization|set-?cookie|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|client[-_]?secret|private[-_]?key|service[-_]?role|bearer)' +
    '["\']?\\s*[:=]\\s*)(["\']?)[^"\'\\s,;&}]+',
  'gi',
);

// Value shapes that are secrets on their own, regardless of any surrounding key.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, // Authorization: Bearer <jwt/opaque>
  /\b[sprkw]k_(?:live|test)_[A-Za-z0-9]{6,}/gi, // Stripe/Clerk sk_/pk_/rk_ + Clerk secret keys
  /\bwhsec_[A-Za-z0-9]{6,}/gi, // Stripe webhook signing secret
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gi, // Anthropic / OpenAI style API keys
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWTs (Supabase / Clerk)
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access-key id
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
];

/**
 * Redact secret-shaped substrings from a free-text string (a message or a stack).
 * Idempotent and safe on empty input.
 */
export function scrubString(input: string | null | undefined): string {
  if (!input) return input ?? '';
  let out = input;
  // 1) standalone secret-shaped tokens anywhere (Bearer/JWT/sk_/pk_/whsec_/…). Run
  //    FIRST so a multi-token value like "Bearer <jwt>" is fully redacted before the
  //    key=value pass (whose value class stops at the first whitespace).
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  // 2) key=value pairs where the KEY names a secret → keep the key + quote, drop the value.
  out = out.replace(KV_SECRET_RE, (_m, keyAndSep: string, quote: string) => `${keyAndSep}${quote}${REDACTED}`);
  return out;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Deep-scrub an arbitrary meta object into a JSON-safe, secret-free structure.
 * - Values under a secret-named key are blanked wholesale ([REDACTED]).
 * - String values are passed through scrubString.
 * - Cycles and over-deep nesting are cut (never throws, never loops).
 */
export function scrubMeta(value: unknown, depth = 0, seen = new WeakSet<object>()): Json {
  if (value == null) return null;
  const t = typeof value;
  if (t === 'string') return scrubString(value as string);
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (t === 'boolean') return value as boolean;
  if (t === 'bigint') return (value as bigint).toString();
  if (t !== 'object') return null; // function / symbol / undefined → drop

  if (depth >= 8) return '[Truncated]';
  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => scrubMeta(v, depth + 1, seen));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : null,
    };
  }

  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : scrubMeta(v, depth + 1, seen);
  }
  return out;
}

// ── Stable fingerprint (digest) ───────────────────────────────────────────────

/** FNV-1a 32-bit → 8-char lowercase hex. Deterministic, no crypto dependency. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Strip volatile tokens so semantically-identical errors normalize to one basis. */
function normalizeForDigest(s: string): string {
  return scrubString(s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/\b\d[\d.,]*\b/g, '#') // numbers, ids, timestamps
    .replace(/\s+/g, ' ')
    .trim();
}

/** First real stack frame, with line:col numbers normalized out. */
function topFrame(stack: string | null | undefined): string {
  if (!stack) return '';
  const line = stack
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at '));
  if (!line) return '';
  return line.replace(/:\d+:\d+\)?$/, '').replace(/\d+/g, '#');
}

export interface DigestBasis {
  name?: string | null;
  message?: string | null;
  stack?: string | null;
  route?: string | null;
}

/**
 * Stable fingerprint for an error occurrence. The SAME logical error (same type,
 * route, and normalized message/top-frame) always yields the same digest, so the
 * dashboard can group + count. Volatile details (ids, line numbers, timestamps)
 * are normalized away before hashing.
 */
export function digestFor(e: DigestBasis): string {
  const basis = [
    e.name ?? 'Error',
    e.route ?? '',
    normalizeForDigest(e.message ?? ''),
    topFrame(e.stack ?? null),
  ].join('|');
  return fnv1a(basis);
}
