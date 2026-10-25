import 'server-only';
/** The records a template can be generated from, for one job (or company, for dealer quotes). */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TemplateKey } from './types';

export interface SourceOption { id: string; label: string; detail: string | null }

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const words = (v: unknown): string => s(v).toLowerCase().replace(/_/g, ' ');

export async function listSources(db: SupabaseClient, key: TemplateKey, where: { jobId: string | null; companyId: string | null }): Promise<SourceOption[]> {
  const pm = db.schema('pm');
  const job = where.jobId;
  const take = async (q: PromiseLike<{ data: unknown; error: unknown }>, map: (r: Row) => SourceOption): Promise<SourceOption[]> => {
    const r = await q;
    return Array.isArray(r.data) ? (r.data as Row[]).map(map) : [];
  };
  switch (key) {
    case 'proposal':
    case 'contract':
      if (!job) return [];
      return take(pm.from('v_estimates_masked').select('id, number, version, title, status').eq('job_id', job).neq('status', 'SUPERSEDED').order('created_at', { ascending: false }).limit(50),
        (r) => ({ id: s(r.id), label: `${s(r.number)}${Number(r.version) > 1 ? ` v${s(r.version)}` : ''} · ${s(r.title)}`, detail: words(r.status) }));
    case 'change_order':
      if (!job) return [];
      return take(pm.from('v_change_orders_masked').select('id, number, title, stage').eq('job_id', job).neq('stage', 'VOID').order('created_at', { ascending: false }).limit(100),
        (r) => ({ id: s(r.id), label: `${s(r.number)} · ${s(r.title)}`, detail: words(r.stage) }));
    case 'pay_app_cover':
      if (!job) return [];
      return take(pm.from('billing_requests').select('id, billing_type, application_no, status, occurred_on').eq('job_id', job).neq('status', 'VOID').order('occurred_on', { ascending: false }).limit(50),
        (r) => ({ id: s(r.id), label: `${r.application_no ? `Application ${s(r.application_no)}` : words(r.billing_type)} · ${s(r.occurred_on)}`, detail: words(r.status) }));
    case 'work_order':
    case 'install_ticket':
      if (!job) return [];
      return take(pm.from('work_orders').select('id, number, summary, kind, status').eq('job_id', job).neq('status', 'CANCELLED').order('created_at', { ascending: false }).limit(100),
        (r) => ({ id: s(r.id), label: `${s(r.number)} · ${s(r.summary)}`, detail: `${words(r.kind)} · ${words(r.status)}` }));
    case 'daily_report':
      if (!job) return [];
      return take(pm.from('field_logs').select('id, log_date, kind').eq('job_id', job).order('log_date', { ascending: false }).limit(60),
        (r) => ({ id: s(r.id), label: `${s(r.log_date)} · ${words(r.kind)} log`, detail: null }));
    case 'purchase_order':
      if (!job) return [];
      return take(pm.from('commitments').select('id, number, title, status').eq('job_id', job).neq('status', 'VOID').order('created_at', { ascending: false }).limit(100),
        (r) => ({ id: s(r.id), label: `${s(r.number)}${r.title ? ` · ${s(r.title)}` : ''}`, detail: words(r.status) }));
    case 'buyers_order':
      if (!where.companyId) return [];
      return take(pm.from('v_dealer_quotes_masked').select('id, number, version, status, issued_at').eq('location_id', where.companyId).in('status', ['ISSUED', 'ACCEPTED']).order('issued_at', { ascending: false }).limit(100),
        (r) => ({ id: s(r.id), label: `${s(r.number)}${Number(r.version) > 1 ? ` v${s(r.version)}` : ''}`, detail: `${words(r.status)} · ${s(r.issued_at).slice(0, 10)}` }));
    case 'draw_request':
      if (!job) return [];
      return take(pm.from('draws').select('id, period_end, status').eq('job_id', job).neq('status', 'CANCELLED').order('period_end', { ascending: false }).limit(60),
        (r) => ({ id: s(r.id), label: `Period to ${s(r.period_end)}`, detail: words(r.status) }));
    case 'lien_waiver':
      if (!job) return [];
      return take(pm.from('compliance_docs').select('id, doc_type, status, covers_through').eq('job_id', job).like('doc_type', 'LIEN_WAIVER%').order('created_at', { ascending: false }).limit(100),
        (r) => ({ id: s(r.id), label: `${words(r.doc_type).replace('lien waiver ', '')} waiver${r.covers_through ? ` through ${s(r.covers_through)}` : ''}`, detail: words(r.status) }));
  }
}
