import 'server-only';
/**
 * Customers on the shared master and the customer 360 (panel 06 BP-62..69, SHARED-RECORDS §2).
 * Every section loads on its own: one failing read shows its own error, never a blank page.
 * Money is masked here per the caller's grants before it reaches the browser.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import type { Access } from '@/lib/access/types';
import { cleanSearch } from '@/lib/pm/db';
import { T, isMissingContract } from './contract';
import { booksMoneyFor, parseBooksMoney, parseRelationship, type BooksMoney, type Relationship } from './c360';
import { contactsFor, listActivities, listLeads, listPipelines, sitesFor } from './queries';
import type { ActivityKind, ContactRow, RelationshipStage, SiteRow, StageKind } from './types';
import { ACTIVITY_WORDS } from './types';

const CUSTOMER_COLS = 'id, name, display_name, email, phone, address_line1, address_line2, city, state, zip, location_id, created_at, is_active, deleted_at';
const MERGED_COLS = 'id, merged_into, deleted_at';

interface CustomerBase {
  id: string;
  name: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  location_id: string | null;
  created_at: string;
  is_active: boolean;
  deleted_at: string | null;
}

function rowsOf<R>(res: { data: unknown; error: PgErrorLike | null }, what: string): R[] {
  if (res.error) throw new PmQueryError(what, res.error);
  return (res.data ?? []) as R[];
}

// ------------------------------------------------------------------ list

export interface CustomerListRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  company: string | null;
  stage: RelationshipStage | null;
  since: string | null;
  createdAt: string;
}

export interface CustomerPage {
  rows: CustomerListRow[];
  total: number;
  page: number;
  perPage: number;
  /** Set when the relationship view is not live yet (stages unknown). */
  stagesUnavailable: boolean;
}

async function relationships(db: SupabaseClient, ids: ReadonlyArray<string>): Promise<{ map: Map<string, Relationship>; unavailable: boolean }> {
  if (!ids.length) return { map: new Map(), unavailable: false };
  const res = await db.schema(T.relationship.schema).from(T.relationship.table).select('customer_id, stage, since').in('customer_id', [...ids]);
  if (res.error) {
    if (isMissingContract(res.error)) return { map: new Map(), unavailable: true };
    throw new PmQueryError('relationship stage', res.error);
  }
  const map = new Map<string, Relationship>();
  for (const r of (res.data ?? []) as Array<{ customer_id: string }>) {
    const rel = parseRelationship(r);
    if (rel) map.set(r.customer_id, rel);
  }
  return { map, unavailable: false };
}

export async function listCustomers(
  db: SupabaseClient,
  f: { q?: string | null; stage?: RelationshipStage | null; companyIds: ReadonlyArray<string>; page?: number; perPage?: number },
  companies: ReadonlyArray<{ id: string; name: string }>,
): Promise<CustomerPage> {
  const perPage = Math.min(Math.max(f.perPage ?? 50, 10), 200);
  const page = Math.max(f.page ?? 1, 1);
  let q = db.schema('pm').from('v_core_customers_masked').select(CUSTOMER_COLS, { count: 'exact' }).eq('is_active', true).is('deleted_at', null);
  const term = cleanSearch(f.q);
  if (term) q = q.or(`name.ilike.*${term}*,display_name.ilike.*${term}*,email.ilike.*${term}*,phone.ilike.*${term}*,city.ilike.*${term}*`);
  if (f.companyIds.length) q = q.or(`location_id.is.null,location_id.in.(${f.companyIds.join(',')})`);
  let stagesUnavailable = false;
  if (f.stage) {
    const ids = await db.schema(T.relationship.schema).from(T.relationship.table).select('customer_id').eq('stage', f.stage).limit(5000);
    if (ids.error) {
      if (!isMissingContract(ids.error)) throw new PmQueryError('relationship stage', ids.error);
      stagesUnavailable = true;
    } else {
      const list = ((ids.data ?? []) as Array<{ customer_id: string }>).map((r) => r.customer_id);
      if (!list.length) return { rows: [], total: 0, page, perPage, stagesUnavailable };
      q = q.in('id', list.slice(0, 1000));
    }
  }
  const res = await q.order('name').order('id').range((page - 1) * perPage, page * perPage - 1);
  const base = rowsOf<CustomerBase>(res, 'customers');
  const rel = await relationships(db, base.map((c) => c.id));
  const names = new Map(companies.map((c) => [c.id, c.name]));
  return {
    rows: base.map((c) => ({
      id: c.id, name: c.display_name || c.name, email: c.email, phone: c.phone, city: [c.city, c.state].filter(Boolean).join(', ') || null,
      company: c.location_id ? names.get(c.location_id) ?? null : null,
      stage: rel.map.get(c.id)?.stage ?? null, since: rel.map.get(c.id)?.since ?? null, createdAt: c.created_at,
    })),
    total: res.count ?? base.length,
    page,
    perPage,
    stagesUnavailable: stagesUnavailable || rel.unavailable,
  };
}

/** Open duplicate reviews (the "Possible duplicates" count). Null when the queue is not live. */
export async function openDuplicateCount(db: SupabaseClient, customerId?: string): Promise<number | null> {
  let q = db.schema(T.duplicateReviews.schema).from(T.duplicateReviews.table).select('id', { count: 'exact', head: true }).eq('status', 'open');
  if (customerId) q = q.or(`a_id.eq.${customerId},b_id.eq.${customerId}`);
  const res = await q;
  if (res.error) return null;
  return res.count ?? 0;
}

// ------------------------------------------------------------------ the 360

export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

async function section<T>(p: Promise<T>, what: string): Promise<Section<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[projects] customer 360 ${what}`, e);
    const missing = e instanceof Error && e.name === 'ContractNotLive';
    return { ok: false, error: missing ? `${what[0]!.toUpperCase()}${what.slice(1)} arrive with the next database update.` : `We couldn’t load ${what}. Try again; if it repeats, tell support.` };
  }
}

export interface C360Lead { id: string; title: string; stage: string; kind: StageKind; amountCents: number | null; updatedAt: string }
export interface C360Estimate { id: string; number: string; version: number; title: string; status: string; jobId: string; totalCents: number | null; date: string }
export interface C360Job { id: string; label: string; stage: string; status: string; contractCents: number | null; companyId: string }
export interface C360Activity { id: string; at: string; kind: ActivityKind; word: string; subject: string | null; body: string | null; leadId: string | null }
export interface C360Document { id: string; name: string; at: string; type: string | null; url: string | null }

export interface Customer360 {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; companyId: string | null; createdAt: string };
  relationship: Relationship | null;
  contacts: Section<ContactRow[]>;
  sites: Section<SiteRow[]>;
  leads: Section<C360Lead[]>;
  estimates: Section<C360Estimate[]>;
  jobs: Section<C360Job[]>;
  activity: Section<C360Activity[]>;
  documents: Section<C360Document[]>;
  /** Null without the contract-value grant (the section is absent) or when Books has nothing. */
  money: Section<BooksMoney | null> | null;
  duplicates: number | null;
}

export async function loadCustomer360(
  db: SupabaseClient,
  access: Access,
  customerId: string,
  view: { companyId: string | null; companyIds: ReadonlyArray<string> },
): Promise<Customer360 | { mergedInto: string } | null> {
  const cRes = await db.schema('pm').from('v_core_customers_masked').select(CUSTOMER_COLS).eq('id', customerId).maybeSingle();
  if (cRes.error) throw new PmQueryError('customer', cRes.error);
  const c = cRes.data as CustomerBase | null;
  if (!c) return null;
  if (c.deleted_at) {
    // merged by core.merge_parties (1111): old links open the record it was merged into
    const m = await db.schema('pm').from('v_core_customers_masked').select(MERGED_COLS).eq('id', customerId).maybeSingle();
    const into = (m.data as { merged_into?: string | null } | null)?.merged_into ?? null;
    return into ? { mergedInto: into } : null;
  }

  // Money: at the customer's own company, else every company in view (a shared customer's AR spans them).
  const moneyCompanies = c.location_id ? [c.location_id] : view.companyId ? [view.companyId] : [...view.companyIds];
  const seesContract = moneyCompanies.length > 0 && moneyCompanies.every((id) => can(access, 'projects.contract_value', 'view', id));
  const contractAt = (loc: string | null) => can(access, 'projects.contract_value', 'view', loc ?? c.location_id ?? view.companyId);

  const jobsP = (async () => {
    const r = rowsOf<{ job_id: string; location_id: string; job_number: string | null; name: string; core_status: string; stage_label: string | null; stage_key: string; contract_revised_cents: number | null }>(
      await db.schema('pm').from('v_project_list').select('job_id, location_id, job_number, name, core_status, stage_label, stage_key, contract_revised_cents').eq('customer_id', customerId).order('updated_at', { ascending: false }).limit(200),
      'jobs',
    );
    return r.map((j): C360Job => ({
      id: j.job_id, label: [j.job_number, j.name].filter(Boolean).join(' · '), stage: j.stage_label ?? j.stage_key, status: j.core_status,
      contractCents: contractAt(j.location_id) ? j.contract_revised_cents : null, companyId: j.location_id,
    }));
  })();

  const leadsP = (async () => {
    const [leads, pipes] = await Promise.all([listLeads(db, { companyIds: [], customerId, limit: 200 }), listPipelines(db, [])]);
    const stages = new Map(pipes.flatMap((p) => p.stages).map((s) => [s.id, s]));
    return leads.map((l): C360Lead => ({
      id: l.id, title: l.title, stage: stages.get(l.stage_id)?.name ?? 'Stage', kind: stages.get(l.stage_id)?.kind ?? 'open',
      amountCents: contractAt(l.location_id) ? l.estimated_value_cents : null, updatedAt: l.updated_at,
    }));
  })();

  const estimatesP = (async () => {
    const r = rowsOf<{ id: string; location_id: string; job_id: string; number: string; version: number; title: string; status: string; total_cents: number | null; created_at: string; sent_at: string | null; accepted_at: string | null }>(
      await db.schema('pm').from('v_estimates_masked').select('id, location_id, job_id, number, version, title, status, total_cents, created_at, sent_at, accepted_at').eq('customer_id', customerId).neq('status', 'SUPERSEDED').order('created_at', { ascending: false }).limit(200),
      'estimates',
    );
    return r.map((e): C360Estimate => ({
      id: e.id, number: e.number, version: e.version, title: e.title, status: e.status, jobId: e.job_id,
      totalCents: contractAt(e.location_id) ? e.total_cents : null, date: (e.accepted_at ?? e.sent_at ?? e.created_at).slice(0, 10),
    }));
  })();

  const activityP = (async () => {
    const [own, leadIds] = await Promise.all([
      listActivities(db, { customerId, limit: 200 }),
      listLeads(db, { companyIds: [], customerId, limit: 200 }).then((ls) => ls.map((l) => l.id)),
    ]);
    const viaLeads = leadIds.length ? await listActivities(db, { leadIds, limit: 200 }) : [];
    const seen = new Set<string>();
    return [...own, ...viaLeads]
      .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, 100)
      .map((a): C360Activity => ({ id: a.id, at: a.occurred_at, kind: a.kind, word: ACTIVITY_WORDS[a.kind] ?? a.kind, subject: a.subject, body: a.body, leadId: a.lead_id }));
  })();

  const documentsP = (async () => {
    const jobs = await jobsP.catch(() => [] as C360Job[]);
    const ids = [customerId, ...jobs.map((j) => j.id)];
    const res = await db.from('documents').select('id, file_name, doc_type, created_at, storage_path, entity_type, entity_id').in('entity_id', ids).order('created_at', { ascending: false }).limit(100);
    const docs = rowsOf<{ id: string; file_name: string; doc_type: string | null; created_at: string; storage_path: string | null }>(res, 'documents');
    const paths = docs.map((d) => d.storage_path).filter((x): x is string => !!x);
    const signed = paths.length ? await db.storage.from('documents').createSignedUrls(paths, 3600) : { data: [] as Array<{ path: string | null; signedUrl: string }>, error: null };
    const url = new Map((signed.data ?? []).map((x) => [x.path ?? '', x.signedUrl]));
    return docs.map((d): C360Document => ({ id: d.id, name: d.file_name, at: d.created_at, type: d.doc_type, url: d.storage_path ? url.get(d.storage_path) ?? null : null }));
  })();

  const moneyP = seesContract
    ? section((async () => {
        const res = await db.schema(T.customer360.schema).from(T.customer360.table).select('*').eq('customer_id', customerId).maybeSingle();
        if (res.error) {
          if (isMissingContract(res.error)) {
            const e = new Error('money');
            e.name = 'ContractNotLive';
            throw e;
          }
          throw new PmQueryError('customer 360', res.error);
        }
        return booksMoneyFor(parseBooksMoney(res.data), seesContract);
      })(), 'money from Merit Books')
    : Promise.resolve(null);

  const relP = db.schema(T.relationship.schema).from(T.relationship.table).select('customer_id, stage, since').eq('customer_id', customerId).maybeSingle();

  const [contacts, sites, leads, estimates, jobs, activity, documents, money, rel, duplicates] = await Promise.all([
    section(contactsFor(db, customerId), 'contacts'),
    section(sitesFor(db, customerId), 'sites'),
    section(leadsP, 'leads'),
    section(estimatesP, 'estimates'),
    section(jobsP, 'jobs'),
    section(activityP, 'activity'),
    section(documentsP, 'documents'),
    moneyP,
    relP,
    openDuplicateCount(db, customerId),
  ]);

  return {
    customer: {
      id: c.id, name: c.display_name || c.name, email: c.email, phone: c.phone,
      address: [c.address_line1, c.address_line2, [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null,
      companyId: c.location_id, createdAt: c.created_at,
    },
    relationship: rel.error ? null : parseRelationship(rel.data),
    contacts, sites, leads, estimates, jobs, activity, documents, money, duplicates,
  };
}
