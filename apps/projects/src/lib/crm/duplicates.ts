import 'server-only';
/**
 * The shared duplicate queue (core.duplicate_reviews, SHARED-RECORDS §4): one queue Merit Books
 * reads too. Loads the pairs, both records side by side, and what would move on a merge.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { CONTACT_COLS, REVIEW_COLS, T, isMissingContract } from './contract';
import type { ContactRow, DuplicateReviewRow } from './types';
import { contactName } from './types';
import { suggestSurvivor, type MoveCounts, type PartyKind, type PartyRecord } from './merge';
import { ContractNotLive } from './queries';

function rowsOf<R>(res: { data: unknown; error: PgErrorLike | null }, what: string): R[] {
  if (res.error) throw new PmQueryError(what, res.error);
  return (res.data ?? []) as R[];
}

type Raw = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

async function records(db: SupabaseClient, kind: PartyKind, ids: ReadonlyArray<string>): Promise<Map<string, PartyRecord>> {
  const u = [...new Set(ids)];
  if (!u.length) return new Map();
  if (kind === 'contact') {
    const list = rowsOf<ContactRow>(await db.schema(T.contacts.schema).from(T.contacts.table).select(CONTACT_COLS).in('id', u), 'contacts');
    return new Map(list.map((c) => [c.id, {
      id: c.id, name: contactName(c), createdAt: c.created_at, booksSince: null,
      fields: { first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, title: c.title },
    }]));
  }
  const view = kind === 'customer' ? 'v_core_customers_masked' : 'v_core_vendors_masked';
  const cols = kind === 'customer' ? 'id, name, display_name, email, phone, address_line1, city, state, zip, created_at' : 'id, name, display_name, email, phone, city, created_at';
  const list = rowsOf<Raw>(await db.schema('pm').from(view).select(cols).in('id', u), kind === 'customer' ? 'customers' : 'vendors');
  return new Map(list.map((r) => {
    const id = String(r.id);
    const fields: Record<string, string | null> = {};
    for (const k of ['name', 'email', 'phone', 'address_line1', 'city', 'state', 'zip']) if (k in r) fields[k] = s(r[k]);
    return [id, { id, name: s(r.display_name) ?? s(r.name) ?? 'Unnamed', createdAt: s(r.created_at), booksSince: null, fields }];
  }));
}

export interface ReviewItem {
  id: string;
  kind: PartyKind;
  score: number;
  matched: string[];
  source: string | null;
  createdAt: string;
  a: PartyRecord | null;
  b: PartyRecord | null;
}

export async function listOpenReviews(db: SupabaseClient, limit = 200): Promise<ReviewItem[]> {
  const res = await db.schema(T.duplicateReviews.schema).from(T.duplicateReviews.table).select(REVIEW_COLS).eq('status', 'open').order('score', { ascending: false }).order('created_at').limit(limit);
  if (res.error && isMissingContract(res.error)) throw new ContractNotLive('duplicate reviews');
  const reviews = rowsOf<DuplicateReviewRow>(res, 'duplicate reviews');
  const byKind = new Map<PartyKind, string[]>();
  for (const r of reviews) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.a_id, r.b_id]);
  const recs = new Map<string, PartyRecord>();
  await Promise.all([...byKind].map(async ([k, ids]) => {
    for (const [id, rec] of await records(db, k, ids)) recs.set(`${k}:${id}`, rec);
  }));
  return reviews.map((r) => ({
    id: r.id, kind: r.kind, score: Number(r.score) > 1 ? Number(r.score) / 100 : Number(r.score), matched: r.matched ?? [], source: r.source, createdAt: r.created_at,
    a: recs.get(`${r.kind}:${r.a_id}`) ?? null, b: recs.get(`${r.kind}:${r.b_id}`) ?? null,
  }));
}

async function countWhere(db: SupabaseClient, schema: string, table: string, col: string, id: string): Promise<number> {
  const res = await db.schema(schema).from(table).select('id', { count: 'exact', head: true }).eq(col, id);
  return res.error ? 0 : res.count ?? 0;
}

async function countJobs(db: SupabaseClient, customerId: string): Promise<number> {
  const res = await db.schema('pm').from('v_project_list').select('job_id', { count: 'exact', head: true }).eq('customer_id', customerId);
  return res.error ? 0 : res.count ?? 0;
}

/** What points at a record in Merit Projects (Books' own references are counted by the merge). */
export async function moveCounts(db: SupabaseClient, kind: PartyKind, id: string): Promise<MoveCounts> {
  if (kind === 'customer') {
    const [contacts, sites, leads, jobs, estimates, activities] = await Promise.all([
      countWhere(db, 'core', 'contacts', 'customer_id', id), countWhere(db, 'core', 'sites', 'customer_id', id),
      countWhere(db, 'crm', 'leads', 'customer_id', id), countJobs(db, id),
      countWhere(db, 'pm', 'v_estimates_masked', 'customer_id', id), countWhere(db, 'crm', 'activities', 'customer_id', id),
    ]);
    return { contacts, sites, leads, jobs, estimates, activities };
  }
  if (kind === 'vendor') {
    const [contacts, commitments] = await Promise.all([countWhere(db, 'core', 'contacts', 'vendor_id', id), countWhere(db, 'pm', 'commitments', 'vendor_id', id)]);
    return { contacts, commitments };
  }
  const [leads, activities] = await Promise.all([countWhere(db, 'crm', 'leads', 'contact_id', id), countWhere(db, 'crm', 'activities', 'contact_id', id)]);
  return { leads, activities };
}

export interface ReviewPair {
  review: ReviewItem;
  a: PartyRecord;
  b: PartyRecord;
  suggestedSurvivorId: string;
  moves: Record<string, MoveCounts>;
}

export async function loadReviewPair(db: SupabaseClient, reviewId: string): Promise<ReviewPair | null> {
  const res = await db.schema(T.duplicateReviews.schema).from(T.duplicateReviews.table).select(REVIEW_COLS).eq('id', reviewId).maybeSingle();
  if (res.error && isMissingContract(res.error)) throw new ContractNotLive('duplicate reviews');
  if (res.error) throw new PmQueryError('duplicate review', res.error);
  const r = res.data as DuplicateReviewRow | null;
  if (!r) return null;
  const recs = await records(db, r.kind, [r.a_id, r.b_id]);
  const a = recs.get(r.a_id);
  const b = recs.get(r.b_id);
  if (!a || !b) return null;
  const [ma, mb] = await Promise.all([moveCounts(db, r.kind, a.id), moveCounts(db, r.kind, b.id)]);
  return {
    review: { id: r.id, kind: r.kind, score: Number(r.score) > 1 ? Number(r.score) / 100 : Number(r.score), matched: r.matched ?? [], source: r.source, createdAt: r.created_at, a, b },
    a, b, suggestedSurvivorId: r.suggested_survivor_id === a.id || r.suggested_survivor_id === b.id ? r.suggested_survivor_id : suggestSurvivor(a, b).id,
    moves: { [a.id]: ma, [b.id]: mb },
  };
}
