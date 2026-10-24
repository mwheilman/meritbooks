/**
 * Matching at the door (SHARED-RECORDS §3). Every create of a customer, contact or vendor asks
 * core.match_parties first; this module is the pure half the server and the form share:
 *
 *   exact identifier  (same email, phone, tax id, or normalized name + address)
 *                     → offer the existing record by default; a new one needs a typed reason
 *   likely match      (similar name plus one shared identifier)
 *                     → the person picks: use existing, or create new
 *   no match          → create
 *
 * Pure and client-safe. The database repeats the score on insert (the duplicate-review safety
 * net), so this is the first line, not the only one.
 */
import { z } from 'zod';

export const MATCH_KINDS = ['customer', 'vendor', 'contact'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** Identifiers that make a match exact on their own. */
export const EXACT_KEYS = ['email', 'phone', 'tax_id', 'name_address'] as const;
/** Below this score a name-only resemblance is not worth showing. */
export const LIKELY_MIN_SCORE = 0.5;
/** A typed reason to create a second record when an exact one exists. */
export const NEW_REASON_MIN = 8;

export interface MatchDetail {
  email: string | null;
  phone: string | null;
  city: string | null;
  /** The day the record was first used in Merit Books (first invoice or bill), null if never. */
  booksSince: string | null;
  createdAt: string | null;
  /** Where it is used: books | projects | crm | core | unused (core.match_parties). */
  source: string | null;
  /** The matcher's own call (1111 core.party_match_level): exact | likely. */
  level: 'exact' | 'likely' | null;
}

export interface MatchCandidate {
  id: string;
  name: string;
  /** 0–1 */
  score: number;
  matched: string[];
  detail: MatchDetail;
}

export type MatchVerdict =
  | { kind: 'none' }
  | { kind: 'likely'; options: MatchCandidate[] }
  | { kind: 'exact'; best: MatchCandidate; others: MatchCandidate[] };

/** What the person decided at the door. */
export type MatchDecision = { use: string } | { create: true; reason: string | null };

// ------------------------------------------------------------------ input

const opt = (max: number) => z.string().trim().max(max).nullish().transform((s) => (s ? s : null));

export const MatchQuery = z.object({
  op: z.enum(MATCH_KINDS),
  name: opt(200),
  email: opt(254),
  phone: opt(40),
  address: opt(300),
  taxId: opt(40),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type MatchQueryInput = z.infer<typeof MatchQuery>;

/** Nothing worth asking about yet (no identifier and a name shorter than 3). */
export function matchWorthAsking(q: Pick<MatchQueryInput, 'name' | 'email' | 'phone' | 'taxId'>): boolean {
  return (q.name?.trim().length ?? 0) >= 3 || !!q.email || digits(q.phone).length >= 7 || !!q.taxId;
}

/** The core.match_parties argument object (names match the §9 contract). */
export function matchArgs(q: MatchQueryInput) {
  return {
    p_kind: q.op,
    p_name: q.name,
    p_email: q.email ? q.email.toLowerCase() : null,
    p_phone: q.phone,
    p_address: q.address,
    p_tax_id: q.taxId,
    p_limit: q.limit,
  };
}

/** The decision a create body carries alongside the new record's fields. */
export const MatchDecisionBody = z
  .object({ useId: z.string().uuid().nullish(), newReason: z.string().trim().max(500).nullish() })
  .nullish()
  .transform((m) => ({ useId: m?.useId ?? null, newReason: m?.newReason ? m.newReason : null }));
export type MatchDecisionInput = z.infer<typeof MatchDecisionBody>;

// ------------------------------------------------------------------ parsing

function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function parseDetail(v: unknown): MatchDetail {
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    email: str(o.email),
    phone: str(o.phone),
    city: str(o.city),
    booksSince: str(o.books_since) ?? str(o.used_in_books_since),
    createdAt: str(o.created_at),
    source: str(o.source),
    level: o.level === 'exact' || o.level === 'likely' ? o.level : null,
  };
}

/** Rows of core.match_parties → candidates (bad rows dropped, best first). */
export function parseCandidates(data: unknown): MatchCandidate[] {
  if (!Array.isArray(data)) return [];
  const out: MatchCandidate[] = [];
  for (const r of data) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    const detail = parseDetail(o.detail);
    // a contact may be only an email or a phone (core.match_parties gives no name then)
    const name = typeof o.name === 'string' && o.name.trim() ? o.name : detail.email ?? detail.phone;
    if (!name) continue;
    const score = Number(o.score);
    out.push({
      id: o.id,
      name,
      score: Number.isFinite(score) ? Math.max(0, Math.min(score > 1 ? score / 100 : score, 1)) : 0,
      matched: Array.isArray(o.matched) ? o.matched.filter((m): m is string => typeof m === 'string') : [],
      detail,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ classification

/** Exact = one hard identifier matched (or name AND address together). The matcher's own level wins. */
export function isExact(c: Pick<MatchCandidate, 'matched'> & { detail?: Pick<MatchDetail, 'level'> }): boolean {
  if (c.detail?.level) return c.detail.level === 'exact';
  const m = new Set(c.matched);
  if (EXACT_KEYS.some((k) => m.has(k))) return true;
  return m.has('name') && m.has('address');
}

/** Likely = similar name plus one shared identifier, or a strong score the matcher stands behind. */
export function isLikely(c: Pick<MatchCandidate, 'matched' | 'score'> & { detail?: Pick<MatchDetail, 'level'> }): boolean {
  if (c.detail?.level) return true;
  if (isExact(c)) return true;
  const m = new Set(c.matched);
  const ids = ['address', 'city', 'zip', 'email_domain', 'phone_partial', 'contact'].filter((k) => m.has(k)).length;
  return (m.has('name') && ids > 0) || c.score >= 0.8 || (m.has('name') && c.score >= LIKELY_MIN_SCORE);
}

export function matchVerdict(cands: ReadonlyArray<MatchCandidate>): MatchVerdict {
  const exact = cands.filter(isExact);
  if (exact.length) {
    const [best, ...rest] = exact;
    return { kind: 'exact', best: best!, others: [...rest, ...cands.filter((c) => !isExact(c) && isLikely(c))] };
  }
  const likely = cands.filter(isLikely);
  return likely.length ? { kind: 'likely', options: likely } : { kind: 'none' };
}

/** The default decision for a verdict: exact → use the existing record; otherwise nothing chosen. */
export function defaultDecision(v: MatchVerdict): MatchDecision | null {
  return v.kind === 'exact' ? { use: v.best.id } : v.kind === 'none' ? { create: true, reason: null } : null;
}

/**
 * New candidates arrived (the person typed more): keep what they chose when it still applies,
 * else fall back to the verdict's default.
 */
export function reconcileDecision(prev: MatchDecision | null, v: MatchVerdict): MatchDecision | null {
  const ids = v.kind === 'exact' ? [v.best, ...v.others].map((c) => c.id) : v.kind === 'likely' ? v.options.map((c) => c.id) : [];
  if (prev && 'use' in prev) return ids.includes(prev.use) ? prev : defaultDecision(v);
  // reason null = the automatic "nothing matched" default; '' or text = the person chose "add new"
  if (prev && 'create' in prev && v.kind !== 'none' && prev.reason !== null) return prev;
  return defaultDecision(v);
}

export type DecisionCheck = { ok: true } | { ok: false; message: string };

/** Can the form submit this decision? Mirrors the server rule in lib/parties/server.ts. */
export function checkDecision(v: MatchVerdict, d: MatchDecision | null, noun = 'record'): DecisionCheck {
  if (!d) return { ok: false, message: `Pick the existing ${noun} or choose to add a new one.` };
  if ('use' in d) return { ok: true };
  if (v.kind === 'exact' && (d.reason?.trim().length ?? 0) < NEW_REASON_MIN) {
    return { ok: false, message: `Say why this is a different ${noun} from ${v.best.name} (at least ${NEW_REASON_MIN} characters).` };
  }
  return { ok: true };
}

/** The decision as the create body carries it. */
export function decisionBody(d: MatchDecision | null): MatchDecisionInput {
  if (!d) return { useId: null, newReason: null };
  return 'use' in d ? { useId: d.use, newReason: null } : { useId: null, newReason: d.reason?.trim() || null };
}

// ------------------------------------------------------------------ words

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "March 2026" (or "March" when it is this year). */
export function monthWords(iso: string, thisYear?: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (!y || !m) return iso;
  const name = MONTHS[m - 1] ?? iso;
  return thisYear === y ? name : `${name} ${y}`;
}

const MATCHED_WORDS: Readonly<Record<string, string>> = {
  email: 'same email', phone: 'same phone', tax_id: 'same tax ID', name_address: 'same name and address',
  name: 'similar name', address: 'same address', city: 'same city', zip: 'same ZIP', email_domain: 'same email domain',
  phone_partial: 'similar phone', contact: 'same contact',
};

export function matchedWords(matched: ReadonlyArray<string>): string {
  const w = matched.map((m) => MATCHED_WORDS[m] ?? m.replace(/_/g, ' '));
  return w.length ? w.join(', ') : 'similar record';
}

/** "Already in Merit: Harbor Holdings — used in Books since March" */
export function alreadyInMerit(c: MatchCandidate, thisYear?: number): string {
  const since = c.detail.booksSince
    ? `used in Books since ${monthWords(c.detail.booksSince, thisYear)}`
    : c.detail.createdAt
      ? `added ${monthWords(c.detail.createdAt, thisYear)}${c.detail.source === 'books' ? ' in Books' : ''}`
      : 'already on your list';
  return `Already in Merit: ${c.name} — ${since}`;
}

/** One line under a candidate: what matched, and where it is. */
export function candidateLine(c: MatchCandidate): string {
  return [matchedWords(c.matched), c.detail.email, c.detail.phone, c.detail.city].filter(Boolean).join(' · ');
}
