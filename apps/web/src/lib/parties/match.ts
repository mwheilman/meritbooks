/**
 * "Already in Merit" — match a new customer / vendor / contact against the ONE shared record set
 * before it is created (Projects migration 1111: core.match_parties, the same scoring curve as
 * lib/customers/dedupe.ts). Suite-level: works whether or not the org uses Merit Projects — a
 * Books-only tenant simply only ever matches Books records.
 *
 * The matcher runs AS THE CALLER (member client): it scopes candidates to what the caller may see,
 * masks contact details they may not, and ignores a tax id unless their field policy reveals
 * taxpayer ids. Nothing below 0.70 is ever returned. detail.level 'exact' (tax id / email / phone
 * matched, or name + address) means "offer the existing record by default".
 *
 * Degrade-safe: if 1111 is not deployed the door is open (available = false, no matches); the
 * AFTER INSERT safety net (core.tg_party_duplicate_net) still files strong matches for review.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;

export type PartyKind = 'customer' | 'vendor' | 'contact';

export interface PartyMatchInput {
  kind: PartyKind;
  name: string;
  email?: string | null;
  phone?: string | null;
  /** Free text: line 1 before the first comma, ZIP = last 5-digit group ('12 Oak St, Ames, IA 50010'). */
  address?: string | null;
  taxId?: string | null;
  limit?: number;
}

export interface PartyMatch {
  id: string;
  name: string;
  score: number;
  matched: string[];
  level: 'exact' | 'likely';
  email: string | null;
  phone: string | null;
  city: string | null;
  booksSince: string | null;
  createdAt: string | null;
  source: 'books' | 'projects' | 'unused' | null;
  masked: boolean;
  /** Plain-English provenance: "used in Projects since March 2026". */
  usage: string;
}

export interface PartyMatchResult {
  available: boolean;
  matches: PartyMatch[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthYear(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : null;
}

/** PURE: the provenance line shown next to a match. */
export function describeUsage(m: Pick<PartyMatch, 'source' | 'booksSince' | 'createdAt'>): string {
  if (m.source === 'books') {
    const since = monthYear(m.booksSince);
    return since ? `used in Books since ${since}` : 'used in Books';
  }
  if (m.source === 'projects') {
    const since = monthYear(m.createdAt);
    return since ? `used in Projects since ${since}` : 'used in Projects';
  }
  const added = monthYear(m.createdAt);
  return added ? `added ${added}, not used yet` : 'not used yet';
}

/** PURE: what MATCHED, in words ("same email", "same tax ID", "similar name"). */
export function describeMatched(matched: readonly string[]): string {
  const words: Record<string, string> = {
    tax_id: 'same tax ID', email: 'same email', phone: 'same phone', address: 'same address', name: 'similar name',
  };
  const out = matched.map((k) => words[k] ?? k.replace(/_/g, ' '));
  return out.length ? out.join(', ') : 'similar name';
}

function missingFunction(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === 'PGRST202' || err.code === '42883' || /could not find the function|function .* does not exist/i.test(err.message ?? '');
}

/**
 * Security review M3 — Books client scope on the matcher's answer. core.match_parties (1111,
 * Projects-owned, SECURITY DEFINER) scopes by the Projects grants and treats a Books seat as
 * org-wide, so it can return another client's customer (name, email, phone) to a client-scoped
 * bookkeeper. Books re-reads the candidate ids through the CALLER's RLS client — 163's
 * client_scope_rls on core.customers (location_id) is the guarantor — and drops anything the
 * caller can't see. A contact follows its customer. Vendors are a shared org-level master (not
 * client-owned, 163), so they pass. A read failure drops every customer / contact candidate
 * (fail closed: the door then simply doesn't offer a match; the duplicate safety net still runs).
 */
export async function visibleToCaller(db: DB, kind: PartyKind, ids: readonly string[]): Promise<Set<string>> {
  if (kind === 'vendor' || ids.length === 0) return new Set(ids);
  try {
    if (kind === 'customer') {
      const { data, error } = await db.schema('core').from('customers').select('id').in('id', [...ids]);
      if (error) return new Set();
      return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
    }
    const { data: contacts, error } = await db.schema('core').from('contacts').select('id, customer_id').in('id', [...ids]);
    if (error) return new Set();
    const rows = (contacts ?? []) as Array<{ id: string; customer_id: string | null }>;
    const custIds = Array.from(new Set(rows.map((r) => r.customer_id).filter((x): x is string => !!x)));
    let seen = new Set<string>();
    if (custIds.length) {
      const { data: cust, error: cErr } = await db.schema('core').from('customers').select('id').in('id', custIds);
      if (cErr) return new Set();
      seen = new Set(((cust ?? []) as Array<{ id: string }>).map((r) => r.id));
    }
    return new Set(rows.filter((r) => !r.customer_id || seen.has(r.customer_id)).map((r) => r.id));
  } catch {
    return new Set();
  }
}

/** Ask the shared matcher. `db` MUST be the caller's (member) client. */
export async function matchParties(db: DB, input: PartyMatchInput): Promise<PartyMatchResult> {
  const name = (input.name ?? '').trim();
  if (name.length < 2 && !input.email && !input.phone && !input.taxId) return { available: true, matches: [] };
  const { data, error } = await db.schema('core').rpc('match_parties', {
    p_kind: input.kind,
    p_name: name,
    p_email: input.email?.trim() || null,
    p_phone: input.phone?.trim() || null,
    p_address: input.address?.trim() || null,
    p_tax_id: input.taxId?.trim() || null,
    p_limit: Math.max(1, Math.min(input.limit ?? 5, 25)),
  });
  if (error) {
    if (missingFunction(error)) return { available: false, matches: [] };
    if (error.code === '42501' || /CORE_FORBIDDEN/.test(error.message ?? '')) return { available: false, matches: [] };
    throw new Error(`Matching failed: ${error.message}`);
  }
  const raw = (Array.isArray(data) ? data : []) as Array<{
    id: string; name: string; score: number | string; matched: string[] | null; detail: Record<string, unknown> | null;
  }>;
  // M3: only candidates the caller can see under Books client scope.
  const visible = await visibleToCaller(db, input.kind, raw.map((r) => r.id));
  const rows = raw.filter((r) => visible.has(r.id));
  return {
    available: true,
    matches: rows.map((r) => {
      const d = r.detail ?? {};
      const m: PartyMatch = {
        id: r.id,
        name: r.name,
        score: Number(r.score),
        matched: r.matched ?? [],
        level: d.level === 'exact' ? 'exact' : 'likely',
        email: (d.email as string | null) ?? null,
        phone: (d.phone as string | null) ?? null,
        city: (d.city as string | null) ?? null,
        booksSince: (d.books_since as string | null) ?? null,
        createdAt: (d.created_at as string | null) ?? null,
        source: (['books', 'projects', 'unused'] as const).find((s) => s === d.source) ?? null,
        masked: d.masked === true,
        usage: '',
      };
      m.usage = describeUsage(m);
      return m;
    }),
  };
}

/** Free-text address for the matcher from the form's parts. */
export function addressText(p: { address_line1?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string | null {
  const line1 = (p.address_line1 ?? '').trim();
  const rest = [p.city, p.state, p.zip].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  if (!line1 && !rest) return null;
  return [line1, rest].filter(Boolean).join(', ');
}

/**
 * Server-side door check for create routes and imports: the strongest match when it is 'exact'
 * (the existing record should be used), unless the caller chose "Create anyway".
 */
export async function exactMatchOrNull(db: DB, input: PartyMatchInput): Promise<PartyMatch | null> {
  try {
    const r = await matchParties(db, { ...input, limit: 3 });
    return r.matches.find((m) => m.level === 'exact') ?? null;
  } catch {
    return null; // the door never blocks on a matcher fault; the safety net still files reviews
  }
}
