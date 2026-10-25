import 'server-only';
/**
 * Staff side of the portals (members, RLS client — never the service role): invite / update /
 * revoke portal access, share documents, mark schedule items and logs client-visible, read and
 * answer portal threads, work the requests, pay applications and date proposals subs send.
 * Every write is a guarded pm.portal_* definer function (1118); reads go through RLS.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { PmQueryError } from '@/lib/api-errors';
import { portalBaseUrl } from './config';

const uuid = z.string().uuid();

export const InviteBody = z.object({
  op: z.enum(['invite_customer', 'invite_vendor', 'invite_lender', 'invite_investor']),
  companyId: uuid,
  contactId: uuid,
  jobIds: z.array(uuid).max(200).default([]),
  allJobs: z.boolean().default(false),
  role: z.enum(['approver', 'viewer']).optional(),
  canSign: z.boolean().optional(),
  canPay: z.boolean().optional(),
  expiresAt: z.string().datetime().nullish(),
  locale: z.enum(['en', 'es']).default('en'),
  send: z.boolean().default(true),
}).refine((b) => b.allJobs || b.jobIds.length > 0, { message: 'Choose the jobs to share', path: ['jobIds'] });
export type InviteInput = z.infer<typeof InviteBody>;

export const UpdateGrantBody = z.object({
  role: z.enum(['approver', 'viewer']).optional(),
  canSign: z.boolean().optional(),
  canPay: z.boolean().optional(),
  allJobs: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  addJobs: z.array(uuid).max(200).optional(),
  removeJobs: z.array(uuid).max(200).optional(),
});

export interface GrantRow {
  id: string; location_id: string; audience: string; customer_id: string | null; vendor_id: string | null; contact_id: string | null;
  display_name: string; email: string | null; phone: string | null; role: string; can_sign: boolean; can_pay: boolean; all_jobs: boolean;
  status: string; expires_at: string | null; invited_at: string; accepted_at: string | null; last_seen_at: string | null; job_ids: string[];
}

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await db.schema('pm').rpc(fn, args);
  if (r.error) throw new PmQueryError(fn, r.error);
  return r.data as T;
}

export async function invite(db: SupabaseClient, b: InviteInput): Promise<{ grant_id: string; message: { status: string; reason: string | null } | null }> {
  return rpc(db, 'portal_invite', {
    p_location: b.companyId, p_audience: b.op.replace('invite_', ''), p_contact: b.contactId, p_jobs: b.jobIds,
    p_attrs: { all_jobs: b.allJobs, role: b.role, can_sign: b.canSign, can_pay: b.canPay, expires_at: b.expiresAt ?? null,
               locale: b.locale, send: b.send, portal_url: portalBaseUrl() },
  });
}

export async function updateGrant(db: SupabaseClient, id: string, b: z.infer<typeof UpdateGrantBody>): Promise<unknown> {
  const patch: Record<string, unknown> = {};
  if (b.role !== undefined) patch.role = b.role;
  if (b.canSign !== undefined) patch.can_sign = b.canSign;
  if (b.canPay !== undefined) patch.can_pay = b.canPay;
  if (b.allJobs !== undefined) patch.all_jobs = b.allJobs;
  if (b.expiresAt !== undefined) patch.expires_at = b.expiresAt ?? '';
  if (b.addJobs) patch.add_jobs = b.addJobs;
  if (b.removeJobs) patch.remove_jobs = b.removeJobs;
  return rpc(db, 'portal_update_grant', { p_grant: id, p_patch: patch });
}

export async function revoke(db: SupabaseClient, id: string, reason: string | null): Promise<void> {
  await rpc(db, 'portal_revoke', { p_grant: id, p_reason: reason });
}

/** Grants the caller may see (RLS: their companies, customers / commitments / billing view). */
export async function listGrants(db: SupabaseClient, f: { jobId?: string; customerId?: string; vendorId?: string; companyId?: string }): Promise<GrantRow[]> {
  let q = db.schema('pm').from('portal_grants')
    .select('id, location_id, audience, customer_id, vendor_id, contact_id, display_name, email, phone, role, can_sign, can_pay, all_jobs, status, expires_at, invited_at, accepted_at, last_seen_at, portal_grant_jobs(job_id)')
    .order('invited_at', { ascending: false }).limit(500);
  if (f.customerId) q = q.eq('customer_id', f.customerId);
  if (f.vendorId) q = q.eq('vendor_id', f.vendorId);
  if (f.companyId) q = q.eq('location_id', f.companyId);
  const r = await q;
  if (r.error) throw new PmQueryError('portal_grants', r.error);
  const rows = (r.data ?? []) as (Omit<GrantRow, 'job_ids'> & { portal_grant_jobs: { job_id: string }[] | null })[];
  return rows
    .map(({ portal_grant_jobs, ...g }) => ({ ...g, job_ids: (portal_grant_jobs ?? []).map((x) => x.job_id) }))
    .filter((g) => !f.jobId || g.all_jobs || g.job_ids.includes(f.jobId));
}

export async function shareDocument(db: SupabaseClient, fileId: string, audiences: string[]): Promise<string[]> {
  return rpc(db, 'portal_share_document', { p_file: fileId, p_audiences: audiences });
}

export async function setClientVisible(db: SupabaseClient, table: 'tasks' | 'field_logs', id: string, visible: boolean): Promise<boolean> {
  return rpc(db, 'portal_set_client_visible', { p_table: table, p_id: id, p_visible: visible });
}

export interface ThreadMessage { id: string; audience: string; party_id: string | null; author_kind: string; author_name: string; body: string; created_at: string; staff_read_at: string | null }

export async function jobThreads(db: SupabaseClient, jobId: string): Promise<ThreadMessage[]> {
  const r = await db.schema('pm').from('portal_messages')
    .select('id, audience, party_id, author_kind, author_name, body, created_at, staff_read_at').eq('job_id', jobId).order('created_at').limit(1000);
  if (r.error) throw new PmQueryError('portal_messages', r.error);
  return (r.data ?? []) as ThreadMessage[];
}

export async function reply(db: SupabaseClient, b: { jobId: string; audience: string; partyId: string | null; body: string }): Promise<{ id: string; notified: number }> {
  return rpc(db, 'portal_post_message', { p_job: b.jobId, p_audience: b.audience, p_party: b.partyId, p_body: b.body, p_portal_url: portalBaseUrl() });
}

export async function listRequests(db: SupabaseClient, f: { companyId?: string; status?: string }): Promise<unknown[]> {
  let q = db.schema('pm').from('portal_requests')
    .select('id, location_id, job_id, customer_id, kind, title, description, preferred_window, document_ids, status, punch_item_id, staff_note, created_at')
    .order('created_at', { ascending: false }).limit(300);
  if (f.companyId) q = q.eq('location_id', f.companyId);
  if (f.status) q = q.eq('status', f.status);
  const r = await q;
  if (r.error) throw new PmQueryError('portal_requests', r.error);
  return r.data ?? [];
}

export async function updateRequest(db: SupabaseClient, b: { id: string; status: string; note?: string | null; punchItemId?: string | null }): Promise<void> {
  await rpc(db, 'portal_update_request', { p_request: b.id, p_status: b.status, p_note: b.note ?? null, p_punch_item: b.punchItemId ?? null });
}

export async function listPayApps(db: SupabaseClient, f: { jobId?: string; commitmentId?: string }): Promise<unknown[]> {
  let q = db.schema('pm').from('portal_pay_apps')
    .select('id, job_id, commitment_id, vendor_id, application_no, vendor_invoice_no, period_end, gross_cents, retainage_cents, net_cents, document_id, note, status, submitted_at, decided_at, decision_note, portal_pay_app_lines(commitment_line_id, pct_complete, this_period_cents, retainage_cents)')
    .order('submitted_at', { ascending: false }).limit(300);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.commitmentId) q = q.eq('commitment_id', f.commitmentId);
  const r = await q;
  if (r.error) throw new PmQueryError('portal_pay_apps', r.error);
  return r.data ?? [];
}

export async function decidePayApp(db: SupabaseClient, b: { id: string; decision: 'approved' | 'rejected'; note?: string | null }): Promise<void> {
  await rpc(db, 'portal_decide_pay_app', { p_pay_app: b.id, p_decision: b.decision, p_note: b.note ?? null });
}

export async function listResponses(db: SupabaseClient, jobId: string): Promise<unknown[]> {
  const r = await db.schema('pm').from('portal_task_responses')
    .select('id, task_id, vendor_id, response, proposed_start, note, resolution, resolved_at, created_at').eq('job_id', jobId)
    .order('created_at', { ascending: false }).limit(300);
  if (r.error) throw new PmQueryError('portal_task_responses', r.error);
  return r.data ?? [];
}

export async function resolveResponse(db: SupabaseClient, id: string, resolution: 'accepted' | 'rejected' | 'noted'): Promise<void> {
  await rpc(db, 'portal_resolve_response', { p_response: id, p_resolution: resolution });
}

export async function portalActivity(db: SupabaseClient, jobId: string): Promise<unknown[]> {
  const r = await db.schema('pm').from('portal_actions')
    .select('id, actor_name, action, subject_table, subject_id, verified_by, at').eq('job_id', jobId).order('at', { ascending: false }).limit(200);
  if (r.error) throw new PmQueryError('portal_actions', r.error);
  return r.data ?? [];
}
