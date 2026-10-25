import 'server-only';
/**
 * Template data from the record it documents, read as the caller (RLS + masked views: a caller
 * without the money capability gets null figures, and the route refuses money templates first).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { unwrap } from '@/lib/documents/errors';
import type { MoneyCap } from '@/lib/documents/types';
import type { LienWaiverType, MoneyLine, Party, TemplateDataMap, TemplateKey } from './types';

export interface Loaded<K extends TemplateKey> {
  data: TemplateDataMap[K];
  jobId: string | null;
  companyId: string;
  subject: { table: string; id: string };
  title: string;
}

/** Which record each template is generated from. */
export const TEMPLATE_SOURCE: Readonly<Record<TemplateKey, { table: string; label: string }>> = {
  proposal: { table: 'estimates', label: 'Estimate' },
  contract: { table: 'estimates', label: 'Estimate' },
  change_order: { table: 'change_orders', label: 'Change order' },
  pay_app_cover: { table: 'billing_requests', label: 'Billing request' },
  work_order: { table: 'work_orders', label: 'Work order' },
  daily_report: { table: 'field_logs', label: 'Daily log' },
  install_ticket: { table: 'work_orders', label: 'Work order' },
  purchase_order: { table: 'commitments', label: 'Purchase order' },
  buyers_order: { table: 'dealer_quotes', label: 'Quote' },
  draw_request: { table: 'draws', label: 'Draw' },
  lien_waiver: { table: 'compliance_docs', label: 'Lien waiver' },
};

/** The money capability a template's figures need (null = none). */
export const TEMPLATE_MONEY: Readonly<Record<TemplateKey, MoneyCap | null>> = {
  proposal: 'projects.contract_value', contract: 'projects.contract_value', change_order: 'projects.contract_value',
  pay_app_cover: 'projects.contract_value', work_order: null, daily_report: null, install_ticket: null,
  purchase_order: 'projects.financials', buyers_order: 'projects.contract_value', draw_request: 'projects.contract_value',
  lien_waiver: 'projects.financials',
};

export interface LoadOptions {
  customerSigners?: Array<string | null>;
  waiverType?: LienWaiverType;
  throughDate?: string | null;
  amountCents?: number | null;
}

const pm = (db: SupabaseClient) => db.schema('pm');

interface JobRow { id: string; location_id: string; job_number: string | null; name: string | null; customer_id: string | null; customer_name: string | null; job_site_address: string | null; job_site_city: string | null; job_site_state: string | null; job_site_zip: string | null }
interface CustomerRow { id: string; name: string; display_name: string | null; email: string | null; phone: string | null; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; zip: string | null }

async function job(db: SupabaseClient, id: string): Promise<JobRow> {
  const j = unwrap<JobRow | null>(await pm(db).from('v_core_jobs_masked').select('id, location_id, job_number, name, customer_id, customer_name, job_site_address, job_site_city, job_site_state, job_site_zip').eq('id', id).maybeSingle());
  if (!j) throw new HttpError(404, 'That job was not found, or it is not one of yours.', 'NOT_FOUND');
  return j;
}

const jobName = (j: JobRow): string => [j.job_number, j.name].filter(Boolean).join(' · ') || 'Job';
const site = (j: JobRow): string | null => [j.job_site_address, [j.job_site_city, j.job_site_state].filter(Boolean).join(', '), j.job_site_zip].filter(Boolean).join(' ') || null;

async function customer(db: SupabaseClient, id: string | null, fallbackName: string | null): Promise<Party> {
  if (id) {
    const c = unwrap<CustomerRow | null>(await pm(db).from('v_core_customers_masked').select('id, name, display_name, email, phone, address_line1, address_line2, city, state, zip').eq('id', id).maybeSingle());
    if (c) {
      return { name: c.display_name || c.name, email: c.email, phone: c.phone,
        lines: [c.address_line1, c.address_line2, [[c.city, c.state].filter(Boolean).join(', '), c.zip].filter(Boolean).join(' ')].filter((x): x is string => !!x) };
    }
  }
  return { name: fallbackName || 'Customer' };
}

async function vendor(db: SupabaseClient, id: string | null): Promise<Party> {
  if (!id) return { name: 'Vendor' };
  const v = unwrap<CustomerRow | null>(await pm(db).from('v_core_vendors_masked').select('id, name, display_name, email, phone, address_line1, address_line2, city, state, zip').eq('id', id).maybeSingle());
  if (!v) return { name: 'Vendor' };
  return { name: v.display_name || v.name, email: v.email, phone: v.phone,
    lines: [v.address_line1, [[v.city, v.state].filter(Boolean).join(', '), v.zip].filter(Boolean).join(' ')].filter((x): x is string => !!x) };
}

async function contractAndChanges(db: SupabaseClient, jobId: string, excludeCo?: string): Promise<{ original: number | null; changes: number | null }> {
  const [c, cos] = await Promise.all([
    pm(db).from('contracts').select('original_cents, kind').eq('job_id', jobId).eq('kind', 'PRIME').limit(1).maybeSingle(),
    pm(db).from('v_change_orders_masked').select('id, amount_cents').eq('job_id', jobId).eq('stage', 'APPROVED'),
  ]);
  const original = (c.data as { original_cents: number } | null)?.original_cents ?? null;
  const rows = ((cos.data ?? []) as Array<{ id: string; amount_cents: number | null }>).filter((x) => x.id !== excludeCo);
  const changes = rows.some((r) => r.amount_cents === null) ? null : rows.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
  return { original: original === null ? null : Number(original), changes };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type LoaderFn<K extends TemplateKey> = (db: SupabaseClient, id: string, o: LoadOptions) => Promise<Loaded<K>>;

async function estimateLoader<K extends 'proposal' | 'contract'>(db: SupabaseClient, id: string, o: LoadOptions, key: K): Promise<Loaded<K>> {
  const e = unwrap<{ id: string; job_id: string; location_id: string; customer_id: string | null; number: string; version: number; title: string; valid_until: string | null; notes: string | null; total_cents: number; retainage_pct: number | null; created_at: string } | null>(
    await pm(db).from('v_estimates_masked').select('id, job_id, location_id, customer_id, number, version, title, valid_until, notes, total_cents, retainage_pct, created_at').eq('id', id).maybeSingle());
  if (!e) throw new HttpError(404, 'That estimate was not found.', 'NOT_FOUND');
  const lines = unwrap<Array<{ description: string; qty: number | null; uom: string | null; unit_price_cents: number | null; amount_cents: number; is_allowance: boolean }>>(
    await pm(db).from('v_estimate_lines_masked').select('description, qty, uom, unit_price_cents, amount_cents, is_allowance, sort, line_no').eq('estimate_id', id).order('sort').order('line_no')) ?? [];
  const j = await job(db, e.job_id);
  const cust = await customer(db, e.customer_id ?? j.customer_id, j.customer_name);
  const ml: MoneyLine[] = lines.map((l) => ({ description: l.description || 'Item', qty: num(l.qty), uom: l.uom, unitCents: num(l.unit_price_cents), amountCents: num(l.amount_cents), note: l.is_allowance ? 'Allowance' : null }));
  const data = {
    number: e.number, version: e.version, date: e.created_at.slice(0, 10), validUntil: e.valid_until, jobName: jobName(j), customer: cust,
    site: site(j), intro: null, lines: ml, allowanceCents: lines.filter((l) => l.is_allowance).reduce((s, l) => s + Number(l.amount_cents), 0) || null,
    totalCents: Number(e.total_cents), retainagePct: e.retainage_pct === null ? null : Number(e.retainage_pct), notes: e.notes,
    customerSigners: o.customerSigners,
  };
  return { data: data as TemplateDataMap[K], jobId: e.job_id, companyId: e.location_id, subject: { table: 'estimates', id }, title: `${key === 'contract' ? 'Contract' : e.title} ${e.number}${e.version > 1 ? ` v${e.version}` : ''}` };
}

const LOADERS: { [K in TemplateKey]: LoaderFn<K> } = {
  proposal: (db, id, o) => estimateLoader(db, id, o, 'proposal'),
  contract: (db, id, o) => estimateLoader(db, id, o, 'contract'),

  change_order: async (db, id, o) => {
    const co = unwrap<{ id: string; job_id: string; number: string | null; title: string; description: string | null; reason: string | null; amount_cents: number | null; schedule_days: number | null; created_at: string } | null>(
      await pm(db).from('v_change_orders_masked').select('id, job_id, number, title, description, reason, amount_cents, schedule_days, created_at').eq('id', id).maybeSingle());
    if (!co) throw new HttpError(404, 'That change order was not found.', 'NOT_FOUND');
    const j = await job(db, co.job_id);
    const { original, changes } = await contractAndChanges(db, co.job_id, co.id);
    return {
      data: { number: co.number ?? 'CO', title: co.title, date: co.created_at.slice(0, 10), jobName: jobName(j), customer: await customer(db, j.customer_id, j.customer_name),
        description: co.description, reason: co.reason, amountCents: num(co.amount_cents), scheduleDays: co.schedule_days, originalContractCents: original, previousChangesCents: changes, customerSigners: o.customerSigners },
      jobId: co.job_id, companyId: j.location_id, subject: { table: 'change_orders', id }, title: `${co.number ?? 'Change order'} ${co.title}`,
    };
  },

  pay_app_cover: async (db, id) => {
    const b = unwrap<{ id: string; job_id: string; location_id: string; application_no: number | null; period_end: string | null; occurred_on: string; net_cents: number; gross_earned_cents: number } | null>(
      await pm(db).from('billing_requests').select('id, job_id, location_id, application_no, period_end, occurred_on, net_cents, gross_earned_cents').eq('id', id).maybeSingle());
    if (!b) throw new HttpError(404, 'That billing request was not found.', 'NOT_FOUND');
    const lines = unwrap<Array<{ line_type: string; total_completed_cents: number | null; retainage_work_to_date_cents: number | null; retainage_stored_to_date_cents: number | null; amount_cents: number }>>(
      await pm(db).from('billing_request_lines').select('line_type, total_completed_cents, retainage_work_to_date_cents, retainage_stored_to_date_cents, amount_cents').eq('billing_request_id', id)) ?? [];
    const std = lines.filter((l) => l.line_type === 'STANDARD');
    const completed = std.some((l) => l.total_completed_cents !== null) ? std.reduce((s, l) => s + Number(l.total_completed_cents ?? 0), 0) : Number(b.gross_earned_cents);
    const retainage = std.reduce((s, l) => s + Number(l.retainage_work_to_date_cents ?? 0) + Number(l.retainage_stored_to_date_cents ?? 0), 0);
    const due = Number(b.net_cents);
    const j = await job(db, b.job_id);
    const { original, changes } = await contractAndChanges(db, b.job_id);
    return {
      data: { applicationNo: b.application_no, periodEnd: b.period_end, date: b.occurred_on, jobName: jobName(j), owner: await customer(db, j.customer_id, j.customer_name),
        originalContractCents: original, changeOrdersCents: changes, totalCompletedCents: completed, retainageCents: retainage,
        previousCertificatesCents: Math.max(0, completed - retainage - due), currentDueCents: due },
      jobId: b.job_id, companyId: b.location_id, subject: { table: 'billing_requests', id }, title: `Application for payment${b.application_no ? ` ${b.application_no}` : ''}`,
    };
  },

  work_order: async (db, id) => woLoader(db, id, 'work_order'),
  install_ticket: async (db, id) => woLoader(db, id, 'install_ticket'),

  daily_report: async (db, id) => {
    const l = unwrap<{ id: string; job_id: string; kind: string; log_date: string; body: string | null; weather: Record<string, unknown> | null; crew_count: number | null; hours: number | null } | null>(
      await pm(db).from('field_logs').select('id, job_id, kind, log_date, body, weather, crew_count, hours').eq('id', id).maybeSingle());
    if (!l) throw new HttpError(404, 'That daily log was not found.', 'NOT_FOUND');
    const j = await job(db, l.job_id);
    const photos = await pm(db).from('document_links').select('id', { count: 'exact', head: true }).eq('subject_table', 'field_logs').eq('subject_id', id);
    const w = l.weather ?? {};
    const weather = [w.summary ?? w.conditions, w.temp_f !== undefined ? `${String(w.temp_f)}°F` : null].filter(Boolean).join(', ') || null;
    return {
      data: { date: l.log_date, jobName: jobName(j), kindLabel: l.kind.charAt(0) + l.kind.slice(1).toLowerCase(), weather: weather as string | null, crewCount: l.crew_count, hours: num(l.hours), body: l.body ?? '', photos: photos.count ?? 0 },
      jobId: l.job_id, companyId: j.location_id, subject: { table: 'field_logs', id }, title: `Daily report ${l.log_date}`,
    };
  },

  purchase_order: async (db, id) => {
    const c = unwrap<{ id: string; job_id: string; location_id: string; vendor_id: string | null; number: string; title: string | null; description: string | null; created_at: string } | null>(
      await pm(db).from('commitments').select('id, job_id, location_id, vendor_id, number, title, description, created_at').eq('id', id).maybeSingle());
    if (!c) throw new HttpError(404, 'That purchase order was not found.', 'NOT_FOUND');
    const lines = unwrap<Array<{ description: string; qty: number | null; uom: string | null; original_amount_cents: number | null }>>(
      await pm(db).from('commitment_lines').select('description, qty, uom, original_amount_cents, line_no').eq('commitment_id', id).order('line_no')) ?? [];
    const j = await job(db, c.job_id);
    const ml: MoneyLine[] = lines.map((l) => {
      const q = num(l.qty);
      const amt = num(l.original_amount_cents);
      return { description: l.description || 'Item', qty: q, uom: l.uom, unitCents: q && amt !== null ? Math.round(amt / q) : null, amountCents: amt };
    });
    return {
      data: { number: c.number, title: c.title ?? c.description, date: c.created_at.slice(0, 10), jobName: jobName(j), vendor: await vendor(db, c.vendor_id), shipTo: site(j), lines: ml, totalCents: ml.reduce((s, l) => s + (l.amountCents ?? 0), 0) },
      jobId: c.job_id, companyId: c.location_id, subject: { table: 'commitments', id }, title: `${c.number}${c.title ? ` ${c.title}` : ''}`,
    };
  },

  buyers_order: async (db, id) => {
    const q = unwrap<{ id: string; location_id: string; number: string; version: number; customer_id: string | null; valid_until: string | null; issued_at: string; snapshot: Record<string, unknown>; totals: Record<string, unknown> } | null>(
      await pm(db).from('v_dealer_quotes_masked').select('id, location_id, number, version, customer_id, valid_until, issued_at, snapshot, totals').eq('id', id).maybeSingle());
    if (!q) throw new HttpError(404, 'That quote was not found.', 'NOT_FOUND');
    const snap = q.snapshot ?? {};
    const t = (q.totals ?? (snap.totals as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const c = (k: string): number => Number(t[k] ?? 0) || 0;
    const lines = (Array.isArray(snap.lines) ? snap.lines : []) as Array<Record<string, unknown>>;
    const trades = (Array.isArray(snap.trades) ? snap.trades : []) as Array<Record<string, unknown>>;
    const fi = (Array.isArray(snap.fi_products) ? snap.fi_products : []) as Array<Record<string, unknown>>;
    return {
      data: {
        number: `${q.number}${q.version > 1 ? ` v${q.version}` : ''}`, date: q.issued_at.slice(0, 10), validUntil: q.valid_until, customer: await customer(db, q.customer_id, null),
        lines: lines.filter((l) => l.line_type !== 'REBATE' && l.line_type !== 'INCENTIVE').map((l) => ({ description: String(l.description ?? l.line_type ?? 'Item'), qty: num(l.qty), unitCents: num(l.unit_price_cents), amountCents: num(l.amount_cents) })),
        trades: trades.map((x) => ({ description: [x.model_year, x.make, x.model, x.serial_number ? `SN ${String(x.serial_number)}` : null].filter(Boolean).join(' ') || 'Trade', allowanceCents: Number(x.allowance_cents ?? 0), payoffCents: Number(x.payoff_cents ?? 0) })),
        products: fi.map((x) => ({ description: String(x.description ?? x.product_type ?? 'Product'), priceCents: Number(x.price_cents ?? 0) })),
        totals: { saleCents: c('sale_price_cents'), feesCents: c('fees_cents'), productsCents: c('fi_price_cents'), taxCents: c('tax_estimate_cents'), cashPriceCents: c('cash_price_cents'),
          tradeAllowanceCents: c('trade_allowance_cents'), tradePayoffCents: c('trade_payoff_cents'), depositsCents: c('deposits_cents'), balanceDueCents: c('balance_due_estimate_cents') },
      },
      jobId: null, companyId: q.location_id, subject: { table: 'dealer_quotes', id }, title: `Buyer's order ${q.number}`,
    };
  },

  draw_request: async (db, id) => {
    const d = unwrap<{ id: string; job_id: string; draw_schedule_id: string; period_end: string; requested_cents: number | null; retainage_held_cents: number | null; equity_applied_cents: number | null; notes: string | null; created_at: string } | null>(
      await pm(db).from('draws').select('id, job_id, draw_schedule_id, period_end, requested_cents, retainage_held_cents, equity_applied_cents, notes, created_at').eq('id', id).maybeSingle());
    if (!d) throw new HttpError(404, 'That draw was not found.', 'NOT_FOUND');
    const [s, all] = await Promise.all([
      pm(db).from('draw_schedules').select('lender_name, loan_number').eq('id', d.draw_schedule_id).maybeSingle(),
      pm(db).from('draws').select('id, created_at').eq('draw_schedule_id', d.draw_schedule_id).order('created_at'),
    ]);
    const sched = (s.data ?? {}) as { lender_name?: string | null; loan_number?: string | null };
    const order = ((all.data ?? []) as Array<{ id: string }>).findIndex((x) => x.id === id);
    const j = await job(db, d.job_id);
    return {
      data: { drawNo: order >= 0 ? order + 1 : null, periodEnd: d.period_end, date: d.created_at.slice(0, 10), jobName: jobName(j), lender: { name: sched.lender_name || 'Lender' }, loanNumber: sched.loan_number ?? null,
        requestedCents: num(d.requested_cents), retainageHeldCents: num(d.retainage_held_cents), equityAppliedCents: num(d.equity_applied_cents), notes: d.notes },
      jobId: d.job_id, companyId: j.location_id, subject: { table: 'draws', id }, title: `Draw request ${order >= 0 ? order + 1 : ''}`.trim(),
    };
  },

  lien_waiver: async (db, id, o) => {
    const c = unwrap<{ id: string; job_id: string; commitment_id: string | null; vendor_id: string | null; doc_type: string; covers_through: string | null } | null>(
      await pm(db).from('compliance_docs').select('id, job_id, commitment_id, vendor_id, doc_type, covers_through').eq('id', id).maybeSingle());
    if (!c || !c.doc_type.startsWith('LIEN_WAIVER')) throw new HttpError(404, 'That lien waiver was not found.', 'NOT_FOUND');
    const j = await job(db, c.job_id);
    let billed: number | null = null;
    if (c.commitment_id) {
      const lines = (await pm(db).from('commitment_lines').select('billed_cents').eq('commitment_id', c.commitment_id)).data as Array<{ billed_cents: number }> | null;
      billed = lines ? lines.reduce((s, l) => s + Number(l.billed_cents ?? 0), 0) : null;
    }
    const type: LienWaiverType = o.waiverType ?? (c.doc_type === 'LIEN_WAIVER_FINAL' ? 'unconditional_final' : c.doc_type === 'LIEN_WAIVER_UNCONDITIONAL' ? 'unconditional_progress' : 'conditional_progress');
    return {
      data: { waiverType: type, date: new Date().toISOString().slice(0, 10), claimant: await vendor(db, c.vendor_id), customer: await customer(db, j.customer_id, j.customer_name), jobName: jobName(j), jobAddress: site(j),
        throughDate: o.throughDate ?? c.covers_through, amountCents: o.amountCents ?? billed },
      jobId: c.job_id, companyId: j.location_id, subject: { table: 'compliance_docs', id }, title: 'Lien waiver',
    };
  },
};

async function woLoader<K extends 'work_order' | 'install_ticket'>(db: SupabaseClient, id: string, key: K): Promise<Loaded<K>> {
  const w = unwrap<{ id: string; job_id: string; location_id: string; number: string | null; kind: string; summary: string; description: string | null; complaint: string | null; cause: string | null; resolution: string | null; scheduled_start: string | null; created_at: string } | null>(
    await pm(db).from('work_orders').select('id, job_id, location_id, number, kind, summary, description, complaint, cause, resolution, scheduled_start, created_at').eq('id', id).maybeSingle());
  if (!w) throw new HttpError(404, 'That work order was not found.', 'NOT_FOUND');
  const lines = unwrap<Array<{ description: string; qty: number; uom: string; unit_price_cents: number | null; amount_cents: number | null; status: string }>>(
    await pm(db).from('v_work_order_lines_masked').select('description, qty, uom, unit_price_cents, amount_cents, status, sort').eq('work_order_id', id).neq('status', 'DECLINED').order('sort')) ?? [];
  const j = await job(db, w.job_id);
  const showPrices = lines.some((l) => l.unit_price_cents !== null);
  const ml: MoneyLine[] = lines.map((l) => ({ description: l.description, qty: num(l.qty), uom: l.uom, unitCents: num(l.unit_price_cents), amountCents: num(l.amount_cents) }));
  const data = {
    number: w.number ?? 'WO', kindLabel: w.kind.charAt(0) + w.kind.slice(1).toLowerCase().replace(/_/g, ' '), date: w.created_at.slice(0, 10), scheduled: w.scheduled_start,
    customer: await customer(db, j.customer_id, j.customer_name), site: site(j), summary: w.summary, description: w.description, complaint: w.complaint, cause: w.cause, resolution: w.resolution,
    lines: ml, showPrices, totalCents: showPrices ? ml.reduce((s, l) => s + (l.amountCents ?? 0), 0) : null,
    ...(key === 'install_ticket' ? { checklist: ['Work matches the order', 'Site cleaned', 'Customer walked through the finished work'] } : {}),
  };
  return { data: data as TemplateDataMap[K], jobId: w.job_id, companyId: w.location_id, subject: { table: 'work_orders', id }, title: `${key === 'install_ticket' ? 'Install ticket' : 'Work order'} ${w.number ?? ''}`.trim() };
}

export async function loadTemplateData<K extends TemplateKey>(db: SupabaseClient, key: K, sourceId: string, o: LoadOptions = {}): Promise<Loaded<K>> {
  return (LOADERS[key] as LoaderFn<K>)(db, sourceId, o);
}
