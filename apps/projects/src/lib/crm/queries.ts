import 'server-only';
/**
 * Reads for the lead flow (crm schema, migration 1111) on the caller's RLS client. Leads,
 * pipelines and activities are company-scoped (class C: projects.leads:view at the company).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import {
  ACTIVITY_COLS, CONTACT_COLS, FOLLOWUP_COLS, LEAD_COLS, PIPELINE_COLS, SITE_COLS, STAGE_COLS, STAGE_EVENT_COLS, T, isMissingContract,
} from './contract';
import type { ActivityRow, ContactRow, FollowupRow, LeadRow, Pipeline, PipelineRow, SiteRow, StageEventRow, StageRow } from './types';

function from(db: SupabaseClient, t: { schema: string; table: string }) {
  return db.schema(t.schema).from(t.table);
}

function list<R>(res: { data: unknown; error: PgErrorLike | null }, what: string): R[] {
  if (res.error) throw new PmQueryError(what, res.error);
  return (res.data ?? []) as R[];
}

/** A read the 1111 contract makes possible: until it is live, the screens show a setup state. */
export class ContractNotLive extends Error {
  constructor(public what: string) {
    super(`${what} is not available yet`);
    this.name = 'ContractNotLive';
  }
}

function listOrMissing<R>(res: { data: unknown; error: PgErrorLike | null }, what: string): R[] {
  if (res.error && isMissingContract(res.error)) throw new ContractNotLive(what);
  return list<R>(res, what);
}

export async function listPipelines(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<Pipeline[]> {
  let q = from(db, T.pipelines).select(PIPELINE_COLS).eq('is_active', true);
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  const pipes = listOrMissing<PipelineRow>(await q.order('is_default', { ascending: false }).order('name'), 'pipelines');
  if (!pipes.length) return [];
  const stages = list<StageRow>(await from(db, T.stages).select(STAGE_COLS).in('pipeline_id', pipes.map((p) => p.id)).order('sort'), 'pipeline stages');
  return pipes.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
}

/** The company's default pipeline (else its first). */
export function defaultPipeline(pipes: ReadonlyArray<Pipeline>, companyId: string | null): Pipeline | null {
  const mine = companyId ? pipes.filter((p) => p.location_id === companyId) : [...pipes];
  return mine.find((p) => p.is_default) ?? mine[0] ?? null;
}

export async function listLeads(db: SupabaseClient, f: { companyIds: ReadonlyArray<string>; pipelineId?: string | null; customerId?: string | null; limit?: number }): Promise<LeadRow[]> {
  let q = from(db, T.leads).select(LEAD_COLS);
  if (f.companyIds.length) q = q.in('location_id', [...f.companyIds]);
  if (f.pipelineId) q = q.eq('pipeline_id', f.pipelineId);
  if (f.customerId) q = q.eq('customer_id', f.customerId);
  return listOrMissing<LeadRow>(await q.order('updated_at', { ascending: false }).limit(f.limit ?? 2000), 'leads');
}

export async function getLead(db: SupabaseClient, id: string): Promise<LeadRow | null> {
  const res = await from(db, T.leads).select(LEAD_COLS).eq('id', id).maybeSingle();
  if (res.error && isMissingContract(res.error)) throw new ContractNotLive('leads');
  if (res.error) throw new PmQueryError('lead', res.error);
  return (res.data ?? null) as LeadRow | null;
}

export async function listActivities(db: SupabaseClient, f: { leadIds?: ReadonlyArray<string>; customerId?: string; limit?: number }): Promise<ActivityRow[]> {
  if (f.leadIds && f.leadIds.length === 0) return [];
  let q = from(db, T.activities).select(ACTIVITY_COLS);
  if (f.leadIds) q = q.in('lead_id', [...f.leadIds]);
  if (f.customerId) q = q.eq('customer_id', f.customerId);
  return list<ActivityRow>(await q.order('occurred_at', { ascending: false }).limit(f.limit ?? 5000), 'activities');
}

export async function listFollowups(db: SupabaseClient, leadIds: ReadonlyArray<string>, openOnly = false): Promise<FollowupRow[]> {
  if (!leadIds.length) return [];
  let q = from(db, T.followups).select(FOLLOWUP_COLS).in('lead_id', [...leadIds]);
  if (openOnly) q = q.is('done_at', null);
  return list<FollowupRow>(await q.order('due_on').limit(5000), 'follow-ups');
}

export async function listStageEvents(db: SupabaseClient, leadIds: ReadonlyArray<string>): Promise<StageEventRow[]> {
  if (!leadIds.length) return [];
  return list<StageEventRow>(await from(db, T.stageEvents).select(STAGE_EVENT_COLS).in('lead_id', [...leadIds]).order('created_at').limit(10000), 'stage history');
}

export async function contactsByIds(db: SupabaseClient, ids: ReadonlyArray<string | null>): Promise<Map<string, ContactRow>> {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map();
  const r = list<ContactRow>(await from(db, T.contacts).select(CONTACT_COLS).in('id', u), 'contacts');
  return new Map(r.map((c) => [c.id, c]));
}

export async function sitesByIds(db: SupabaseClient, ids: ReadonlyArray<string | null>): Promise<Map<string, SiteRow>> {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map();
  const r = list<SiteRow>(await from(db, T.sites).select(SITE_COLS).in('id', u), 'sites');
  return new Map(r.map((s) => [s.id, s]));
}

export async function contactsFor(db: SupabaseClient, customerId: string): Promise<ContactRow[]> {
  return listOrMissing<ContactRow>(await from(db, T.contacts).select(CONTACT_COLS).eq('customer_id', customerId).eq('identity_status', 'active').order('is_primary', { ascending: false }).order('last_name'), 'contacts');
}

export async function sitesFor(db: SupabaseClient, customerId: string): Promise<SiteRow[]> {
  return listOrMissing<SiteRow>(await from(db, T.sites).select(SITE_COLS).eq('customer_id', customerId).eq('identity_status', 'active').order('name'), 'sites');
}

export interface CustomerName {
  id: string;
  name: string;
  location_id: string | null;
}

export async function customerNames(db: SupabaseClient, ids: ReadonlyArray<string | null>): Promise<Map<string, CustomerName>> {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map();
  const r = list<{ id: string; name: string; display_name: string | null; location_id: string | null }>(
    await db.schema('pm').from('v_core_customers_masked').select('id, name, display_name, location_id').in('id', u),
    'customers',
  );
  return new Map(r.map((c) => [c.id, { id: c.id, name: c.display_name || c.name, location_id: c.location_id }]));
}

/** Membership id → display name, from the company team view (rows only with projects.team:view). */
export async function memberNames(db: SupabaseClient, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map();
  const res = await db.schema('pm').from('v_company_team').select('membership_id, display_name, email').in('membership_id', u).limit(5000);
  if (res.error) return new Map();
  const out = new Map<string, string>();
  for (const r of (res.data ?? []) as Array<{ membership_id: string; display_name: string | null; email: string | null }>) {
    if (!out.has(r.membership_id)) out.set(r.membership_id, r.display_name || r.email || 'Team member');
  }
  return out;
}

export interface OwnerOption {
  membershipId: string;
  name: string;
}

/** People who can own a lead at a company (team view), the caller first. */
export async function ownerOptions(db: SupabaseClient, companyIds: ReadonlyArray<string>, me: string | null): Promise<OwnerOption[]> {
  let q = db.schema('pm').from('v_company_team').select('membership_id, display_name, email, location_id');
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  const res = await q.limit(5000);
  const seen = new Map<string, string>();
  if (!res.error) for (const r of (res.data ?? []) as Array<{ membership_id: string; display_name: string | null; email: string | null }>) {
    if (!seen.has(r.membership_id)) seen.set(r.membership_id, r.display_name || r.email || 'Team member');
  }
  if (me && !seen.has(me)) seen.set(me, 'Me');
  return [...seen].map(([membershipId, name]) => ({ membershipId, name: membershipId === me ? `${name === 'Me' ? 'Me' : `${name} (me)`}` : name }))
    .sort((a, b) => (a.membershipId === me ? -1 : b.membershipId === me ? 1 : a.name.localeCompare(b.name)));
}
