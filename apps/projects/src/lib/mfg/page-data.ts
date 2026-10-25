import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Opt } from '@/lib/dealer/page-data';

/** Picker lists the 1125 manufacturing pages pass to their screens (caller's RLS; capped). */
type Q = PromiseLike<{ data: unknown; error: unknown }>;
async function list<T>(q: Q): Promise<T[]> {
  const r = await q;
  return r.error ? [] : ((r.data ?? []) as T[]);
}
const NONE = ['00000000-0000-0000-0000-000000000000'];

export async function areaOpts(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<Array<Opt & { jobId: string }>> {
  const r = await list<{ id: string; job_id: string; name: string; code: string | null }>(db.schema('pm').from('wbs_nodes').select('id, job_id, name, code').in('job_id', jobIds.length ? [...jobIds] : NONE).is('parent_id', null).order('sort').limit(2000));
  return r.map((a) => ({ id: a.id, jobId: a.job_id, label: a.code ? `${a.code} · ${a.name}` : a.name }));
}

export async function estimateOpts(db: SupabaseClient, companyId: string, jobLabel: (id: string) => string, statuses: ReadonlyArray<string> = ['DRAFT', 'SENT', 'ACCEPTED']): Promise<Array<Opt & { jobId: string; proposalId: string | null; status: string }>> {
  const r = await list<{ id: string; number: string; title: string | null; job_id: string; status: string; version: number }>(
    db.schema('pm').from('estimates').select('id, number, title, job_id, status, version').eq('location_id', companyId).in('status', [...statuses]).order('created_at', { ascending: false }).limit(500));
  const pr = await db.schema('pm').rpc('mfg_proposal_list', { p_location: companyId });
  const byEst = new Map<string, string>(((pr.error ? [] : pr.data ?? []) as Array<{ id: string; estimate_id: string }>).map((p) => [p.estimate_id, p.id]));
  return r.map((e) => ({ id: e.id, jobId: e.job_id, status: e.status, proposalId: byEst.get(e.id) ?? null, label: `${e.number} v${e.version} · ${e.title ?? jobLabel(e.job_id)}`, sub: e.status.toLowerCase() }));
}

export async function productOpts(db: SupabaseClient, companyId: string): Promise<Opt[]> {
  const r = await db.schema('pm').rpc('mfg_product_library', { p_location: companyId });
  if (r.error) return [];
  return ((r.data ?? []) as Array<{ id: string; code: string; name: string; is_active: boolean }>).filter((p) => p.is_active).map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` }));
}

export async function pdfDocOpts(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<Array<Opt & { jobId: string }>> {
  const r = await list<{ id: string; title: string; job_id: string }>(db.schema('pm').from('doc_files').select('id, title, job_id').in('job_id', jobIds.length ? [...jobIds] : NONE).eq('status', 'active').order('created_at', { ascending: false }).limit(1000));
  return r.map((d) => ({ id: d.id, jobId: d.job_id, label: d.title }));
}

export async function memberOpts(db: SupabaseClient, companyId: string): Promise<Opt[]> {
  const r = await list<{ membership_id: string; display_name: string | null; email: string | null }>(db.schema('pm').from('v_company_team').select('membership_id, display_name, email').eq('location_id', companyId).limit(500));
  const seen = new Set<string>();
  return r.filter((x) => !seen.has(x.membership_id) && seen.add(x.membership_id)).map((x) => ({ id: x.membership_id, label: x.display_name || x.email || 'Member' }));
}

export async function productionOrderOpts(db: SupabaseClient, companyId: string): Promise<Array<Opt & { jobId: string }>> {
  const r = await list<{ id: string; number: string; summary: string; job_id: string; status: string }>(db.schema('pm').from('work_orders').select('id, number, summary, job_id, status').eq('location_id', companyId).eq('kind', 'PRODUCTION').not('status', 'in', '(CLOSED,CANCELLED)').order('number', { ascending: false }).limit(400));
  return r.map((w) => ({ id: w.id, jobId: w.job_id, label: `${w.number} · ${w.summary}`, sub: w.status.toLowerCase() }));
}

export async function operationOpts(db: SupabaseClient, orderIds: ReadonlyArray<string>, orderLabel: (id: string) => string): Promise<Array<Opt & { woId: string }>> {
  const r = await list<{ id: string; name: string; seq: number; work_order_id: string; status: string }>(db.schema('pm').from('wo_operations').select('id, name, seq, work_order_id, status').in('work_order_id', orderIds.length ? [...orderIds] : NONE).neq('status', 'DONE').order('seq').limit(2000));
  return r.map((o) => ({ id: o.id, woId: o.work_order_id, label: `${orderLabel(o.work_order_id)} · ${o.seq}. ${o.name}` }));
}
