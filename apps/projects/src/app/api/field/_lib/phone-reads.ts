import 'server-only';
/**
 * The phone-only reads behind the Wave C routes (/api/field/extras, drawings, sell, ro, pay,
 * sign). Every read is on the caller's RLS client and selects named, non-money columns, except
 * where the money belongs on the screen and is the caller's to see:
 *   - service: the customer-facing option prices, member prices, rebates, financing terms and the
 *     membership price (what the technician shows the customer). Cost and dealer fee are dropped.
 *   - pay: the installer's OWN pay tickets (filtered to their employee id, on top of RLS).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { can } from '@/lib/access/can';
import type { Access } from '@/lib/access/types';
import { PmQueryError } from '@/lib/api-errors';
import { signedUrls } from '@/lib/documents/store';
import { addDays, todayIso } from '@/lib/time';
import { mondayOf } from '@/lib/pm/ops/week';
import type { ReadyTenant } from '@/lib/api';
import {
  FINANCING_COLS, FS_ESTIMATE_COLS, FS_OPTION_COLS, FS_OPTION_ITEM_COLS, TEMPLATE_COLS,
  type AgreementTemplateRow, type FinancingPlanRow, type FsEstimateRow, type FsOptionItemRow, type FsOptionRow, type OptionTotalsRow, type PrejobBrief,
} from '@/lib/fieldservice/types';

type Q = PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;

async function rows<T>(q: Q, what: string): Promise<T[]> {
  const r = await q;
  if (r.error) throw new PmQueryError(what, r.error);
  return (r.data ?? []) as T[];
}

/** A read that may fail on a tenant without that module (a missing view / RLS): empty, not an error. */
async function soft<T>(q: Q): Promise<T[]> {
  const r = await q;
  return r.error ? [] : ((r.data ?? []) as T[]);
}

const NONE = '00000000-0000-0000-0000-000000000000';
const list = (ids: ReadonlyArray<string>) => (ids.length ? [...ids] : [NONE]);

async function myEmployeeId(db: SupabaseClient, userId: string): Promise<string | null> {
  const r = await db.schema('core').from('employees').select('id').eq('clerk_user_id', userId).eq('is_active', true).limit(1).maybeSingle();
  return r.error ? null : ((r.data as { id: string } | null)?.id ?? null);
}

// ------------------------------------------------------------------------------------- extras

export interface HomeNotes {
  lockboxCode: string | null;
  gateCode: string | null;
  garageCode: string | null;
  alarmCode: string | null;
  pets: string | null;
  children: string | null;
  workHours: string | null;
  parking: string | null;
  offLimits: string | null;
  utilityNotice: string | null;
  tempKitchen: string | null;
  bathroomForCrew: string | null;
  notes: string | null;
  occupied: boolean;
  rrpRequired: boolean;
}

export interface VisitExtra {
  kind: string;
  number: string | null;
  status: string;
  complaint: string | null;
  gateCode: string | null;
  pets: string | null;
  accessNotes: string | null;
  member: boolean;
  /** Field-service options on the visit: open = can be presented / sold now. */
  estimates: { open: number; sold: number };
}

/** From pm.res_field_sites (1124, RES-68) when the tenant has it: what arrives and what to check today. */
export interface SiteToday {
  deliveries: Array<{ description: string; expectedOn: string | null; status: string }>;
  checksOpen: number;
  rrpOpen: boolean;
}

export interface FieldExtras {
  serverTime: string;
  visits: Record<string, VisitExtra>;
  homes: Record<string, HomeNotes>;
  sites: Record<string, SiteToday>;
  drawings: Record<string, number>;
  features: { approvals: boolean; esign: boolean; drawings: boolean; kiosk: boolean; roClock: boolean; installerPay: boolean };
  stations: Array<{ companyId: string; name: string }>;
}

const SERVICE_KINDS = new Set(['SERVICE', 'MAINTENANCE_VISIT', 'INSTALL', 'MEASURE', 'INSPECTION']);

export async function loadExtras(db: SupabaseClient, tenant: ReadyTenant, access: Access, userId: string, wo: string[], jobs: string[]): Promise<FieldExtras> {
  const [orders, homesRaw, sheets, me] = await Promise.all([
    wo.length ? rows<{ id: string; kind: string; number: string | null; status: string; summary: string }>(db.schema('pm').from('work_orders').select('id, kind, number, status, summary').in('id', wo), 'visits') : Promise.resolve([]),
    jobs.length
      ? soft<{ job_id: string; occupied: boolean; lockbox_code: string | null; gate_code: string | null; garage_code: string | null; alarm_code: string | null; pets: string | null; children: string | null; work_hours: string | null; parking: string | null; off_limits: string | null; utility_notice: string | null; temp_kitchen: string | null; bathroom_for_crew: string | null; notes: string | null; rrp_required: boolean | null }>(
          db.schema('pm').from('res_home_profiles').select('job_id, occupied, lockbox_code, gate_code, garage_code, alarm_code, pets, children, work_hours, parking, off_limits, utility_notice, temp_kitchen, bathroom_for_crew, notes, rrp_required').in('job_id', jobs))
      : Promise.resolve([]),
    jobs.length ? soft<{ job_id: string }>(db.schema('pm').from('drawing_sheets').select('job_id').in('job_id', jobs).not('current_revision_id', 'is', null).limit(5000)) : Promise.resolve([]),
    myEmployeeId(db, userId),
  ]);

  const visits: Record<string, VisitExtra> = {};
  const service = orders.filter((o) => SERVICE_KINDS.has(o.kind)).slice(0, 15);
  const estimates = service.length
    ? await soft<{ work_order_id: string; status: string }>(db.schema('pm').from('fs_estimates').select('work_order_id, status').in('work_order_id', service.map((o) => o.id)))
    : [];
  const briefs = await Promise.all(service.map(async (o) => {
    const r = await db.schema('pm').rpc('fs_prejob_brief', { p_wo: o.id });
    return [o.id, r.error ? null : (r.data as PrejobBrief)] as const;
  }));
  const briefBy = new Map(briefs);
  for (const o of orders) {
    const b = briefBy.get(o.id) ?? null;
    const est = estimates.filter((e) => e.work_order_id === o.id);
    visits[o.id] = {
      kind: o.kind, number: o.number, status: o.status, complaint: b?.work_order?.complaint ?? null,
      gateCode: b?.site?.gate_code ?? null, pets: b?.site?.pets ?? null, accessNotes: b?.site?.access_notes ?? null, member: !!b?.is_member,
      estimates: { open: est.filter((e) => e.status === 'DRAFT' || e.status === 'PRESENTED').length, sold: est.filter((e) => e.status === 'SOLD').length },
    };
  }

  const homes: Record<string, HomeNotes> = {};
  for (const h of homesRaw) {
    homes[h.job_id] = {
      lockboxCode: h.lockbox_code, gateCode: h.gate_code, garageCode: h.garage_code, alarmCode: h.alarm_code, pets: h.pets, children: h.children,
      workHours: h.work_hours, parking: h.parking, offLimits: h.off_limits, utilityNotice: h.utility_notice, tempKitchen: h.temp_kitchen,
      bathroomForCrew: h.bathroom_for_crew, notes: h.notes, occupied: h.occupied, rrpRequired: !!h.rrp_required,
    };
  }
  const drawings: Record<string, number> = {};
  for (const s of sheets) drawings[s.job_id] = (drawings[s.job_id] ?? 0) + 1;

  // residential "Today" site cards (1124): deliveries today / tomorrow, open protection checks, RRP
  const sites: Record<string, SiteToday> = {};
  if (jobs.length) {
    const r = await db.schema('pm').rpc('res_field_sites', { p_jobs: jobs.slice(0, 50), p_day: null });
    const list = r.error || !Array.isArray(r.data) ? [] : (r.data as Array<{ job_id: string; rrp?: boolean; deliveries?: Array<{ description?: string; expected_on?: string | null; status?: string }>; checks_open?: unknown[] }>);
    for (const x of list) {
      const deliveries = (x.deliveries ?? []).map((d) => ({ description: d.description ?? '', expectedOn: d.expected_on ?? null, status: d.status ?? '' })).filter((d) => d.description);
      const checksOpen = Array.isArray(x.checks_open) ? x.checks_open.length : 0;
      if (deliveries.length || checksOpen || x.rrp) sites[x.job_id] = { deliveries, checksOpen, rrpOpen: !!x.rrp };
    }
  }

  const stations = tenant.companies.filter((c) => can(access, 'projects.production', 'edit', c.id)).map((c) => ({ companyId: c.id, name: c.name }));
  // the pay card shows for installers who have piece-rate tickets (own rows only)
  const payRows = me ? await soft<{ id: string }>(db.schema('pm').from('v_flr_pay_tickets_masked').select('id').eq('employee_id', me).limit(1)) : [];
  return {
    serverTime: new Date().toISOString(),
    visits, homes, sites, drawings,
    features: {
      approvals: true,
      esign: can(access, 'projects.documents', 'create'),
      drawings: can(access, 'projects.documents', 'view'),
      kiosk: stations.length > 0,
      roClock: orders.some((o) => o.kind === 'REPAIR_ORDER' || o.kind === 'PDI') || can(access, 'projects.store', 'view'),
      installerPay: payRows.length > 0,
    },
    stations,
  };
}

// ----------------------------------------------------------------------------------- drawings

export interface PhoneSheet {
  sheetId: string;
  jobId: string;
  number: string;
  title: string | null;
  discipline: string | null;
  revisionId: string;
  revisionLabel: string | null;
  setName: string;
  issuedOn: string | null;
  /** Signed for one hour: the phone downloads it into its own storage right away. */
  url: string | null;
  bytes: number | null;
}

/** The CURRENT revision of every sheet on these jobs (superseded sheets are never offered). */
export async function loadDrawings(db: SupabaseClient, jobIds: string[]): Promise<{ sheets: PhoneSheet[]; serverTime: string }> {
  if (!jobIds.length) return { sheets: [], serverTime: new Date().toISOString() };
  const pm = db.schema('pm');
  const sheets = await rows<{ id: string; job_id: string; sheet_number: string; title: string | null; discipline: string | null; current_revision_id: string | null }>(
    pm.from('drawing_sheets').select('id, job_id, sheet_number, title, discipline, current_revision_id').in('job_id', jobIds).not('current_revision_id', 'is', null).order('sheet_number').limit(3000),
    'sheets',
  );
  const revIds = sheets.map((s) => s.current_revision_id!).filter(Boolean);
  const revs = revIds.length
    ? await rows<{ id: string; set_id: string; document_id: string; revision_label: string | null; title: string | null }>(pm.from('drawing_revisions').select('id, set_id, document_id, revision_label, title').in('id', revIds), 'revisions')
    : [];
  const sets = revs.length
    ? await rows<{ id: string; name: string; issued_on: string | null }>(pm.from('drawing_sets').select('id, name, issued_on').in('id', list([...new Set(revs.map((r) => r.set_id))])), 'sets')
    : [];
  const docs = revs.length
    ? await rows<{ id: string; storage_path: string; size_bytes: number | null }>(db.from('documents').select('id, storage_path, size_bytes').in('id', list(revs.map((r) => r.document_id))), 'sheet files')
    : [];
  const urls = await signedUrls(db, docs.map((d) => d.storage_path), 3600);
  const revBy = new Map(revs.map((r) => [r.id, r]));
  const setBy = new Map(sets.map((s) => [s.id, s]));
  const docBy = new Map(docs.map((d) => [d.id, d]));
  const out: PhoneSheet[] = [];
  for (const s of sheets) {
    const r = revBy.get(s.current_revision_id!);
    if (!r) continue;
    const d = docBy.get(r.document_id);
    const set = setBy.get(r.set_id);
    out.push({
      sheetId: s.id, jobId: s.job_id, number: s.sheet_number, title: s.title ?? r.title, discipline: s.discipline, revisionId: r.id, revisionLabel: r.revision_label,
      setName: set?.name ?? 'Set', issuedOn: set?.issued_on ?? null, url: d ? urls.get(d.storage_path) ?? null : null, bytes: d?.size_bytes ?? null,
    });
  }
  return { sheets: out, serverTime: new Date().toISOString() };
}

// ------------------------------------------------------------------------- field-service sell

export interface SellOption {
  id: string;
  estimateId: string;
  tier: FsOptionRow['tier'];
  name: string;
  description: string | null;
  recommended: boolean;
  status: FsOptionRow['status'];
  rebateCents: number;
  rebateNote: string | null;
  financingPlanId: string | null;
  regularCents: number;
  memberCents: number;
}

export interface SellItem {
  id: string;
  optionId: string;
  description: string;
  qty: number;
  unitPriceCents: number;
  memberUnitPriceCents: number | null;
  optional: boolean;
  selected: boolean;
}

export interface SellBundle {
  workOrderId: string;
  jobId: string;
  companyId: string;
  member: boolean;
  customer: string | null;
  estimates: Array<Pick<FsEstimateRow, 'id' | 'number' | 'title' | 'status' | 'member_pricing' | 'signed_name' | 'signed_at' | 'deposit_cents'>>;
  options: SellOption[];
  items: SellItem[];
  plans: Array<{ id: string; provider: string; name: string; apr: number; termMonths: number; promo: string | null; minCents: number; maxCents: number | null; isDefault: boolean }>;
  memberships: Array<{ id: string; planName: string; tier: string | null; termMonths: number; priceCents: number; billingFrequency: string; memberDiscountPct: number; visitsPerTerm: number }>;
}

export async function loadSell(db: SupabaseClient, workOrderId: string): Promise<SellBundle | null> {
  const pm = db.schema('pm');
  const wo = (await rows<{ id: string; job_id: string; location_id: string }>(pm.from('work_orders').select('id, job_id, location_id').eq('id', workOrderId).limit(1), 'visit'))[0];
  if (!wo) return null;
  const [estimates, plans, templates, briefRes] = await Promise.all([
    soft<FsEstimateRow>(pm.from('fs_estimates').select(FS_ESTIMATE_COLS).eq('work_order_id', wo.id).in('status', ['DRAFT', 'PRESENTED', 'SOLD']).order('created_at', { ascending: false }).limit(10)),
    soft<FinancingPlanRow>(pm.from('v_financing_plans_masked').select(FINANCING_COLS).eq('location_id', wo.location_id).eq('is_active', true).order('term_months')),
    soft<AgreementTemplateRow>(pm.from('agreement_templates').select(TEMPLATE_COLS).eq('location_id', wo.location_id).eq('is_active', true).eq('label', 'MEMBERSHIP').order('sort')),
    pm.rpc('fs_prejob_brief', { p_wo: wo.id }),
  ]);
  const estIds = estimates.map((e) => e.id);
  const options = estIds.length ? await soft<FsOptionRow>(pm.from('fs_estimate_options').select(FS_OPTION_COLS).in('estimate_id', estIds).order('sort')) : [];
  const optIds = options.map((o) => o.id);
  const [items, totals] = optIds.length
    ? await Promise.all([
        soft<FsOptionItemRow>(pm.from('v_fs_estimate_option_items_masked').select(FS_OPTION_ITEM_COLS).in('option_id', optIds).order('sort')),
        soft<OptionTotalsRow>(pm.from('v_fs_option_totals').select('option_id, estimate_id, regular_cents, member_cents, rebate_cents').in('option_id', optIds)),
      ])
    : [[] as FsOptionItemRow[], [] as OptionTotalsRow[]];
  const brief = briefRes.error ? null : (briefRes.data as PrejobBrief);
  const totBy = new Map(totals.map((t) => [t.option_id, t]));
  return {
    workOrderId: wo.id, jobId: wo.job_id, companyId: wo.location_id, member: !!brief?.is_member, customer: brief?.customer?.name ?? null,
    estimates: estimates.map((e) => ({ id: e.id, number: e.number, title: e.title, status: e.status, member_pricing: e.member_pricing, signed_name: e.signed_name, signed_at: e.signed_at, deposit_cents: Number(e.deposit_cents ?? 0) })),
    options: options.map((o) => {
      const t = totBy.get(o.id);
      return {
        id: o.id, estimateId: o.estimate_id, tier: o.tier, name: o.name, description: o.description, recommended: o.recommended, status: o.status,
        rebateCents: Number(o.rebate_cents ?? 0), rebateNote: o.rebate_note, financingPlanId: o.financing_plan_id,
        regularCents: Number(t?.regular_cents ?? 0), memberCents: Number(t?.member_cents ?? t?.regular_cents ?? 0),
      };
    }),
    // unit_cost_cents is never sent to the phone
    items: items.map((i) => ({
      id: i.id, optionId: i.option_id, description: i.description, qty: Number(i.qty), unitPriceCents: Number(i.unit_price_cents),
      memberUnitPriceCents: i.member_unit_price_cents == null ? null : Number(i.member_unit_price_cents), optional: i.is_optional, selected: i.is_selected,
    })),
    // dealer_fee_pct is never sent to the phone
    plans: plans.map((p) => ({ id: p.id, provider: p.provider, name: p.name, apr: Number(p.apr), termMonths: p.term_months, promo: p.promo, minCents: Number(p.min_cents ?? 0), maxCents: p.max_cents == null ? null : Number(p.max_cents), isDefault: p.is_default })),
    memberships: templates.map((m) => ({ id: m.id, planName: m.plan_name, tier: m.tier, termMonths: m.term_months, priceCents: Number(m.price_cents), billingFrequency: m.billing_frequency, memberDiscountPct: Number(m.member_discount_pct), visitsPerTerm: m.visits_per_term })),
  };
}

// ------------------------------------------------------------------------------ dealer RO clock

export interface PhoneRo {
  id: string;
  number: string | null;
  summary: string;
  status: string;
  jobId: string;
  companyId: string;
  mine: boolean;
}

export interface PhoneRoLine {
  id: string;
  workOrderId: string;
  description: string;
  laborOp: string | null;
  flagHours: number | null;
  status: string;
}

export interface RoBundle {
  serverTime: string;
  stores: Array<{ companyId: string; name: string }>;
  ros: PhoneRo[];
  lines: PhoneRoLine[];
  open: { companyId: string; lineId: string | null; kind: string; startedAt: string } | null;
}

/** Open repair orders at the stores where I clock time (mine first), their labor lines, my open punch. Hours only. */
export async function loadRo(db: SupabaseClient, tenant: ReadyTenant, access: Access, userId: string): Promise<RoBundle> {
  const stores = tenant.companies.filter((c) => can(access, 'projects.time', 'create', c.id)).map((c) => ({ companyId: c.id, name: c.name }));
  const pm = db.schema('pm');
  const me = await myEmployeeId(db, userId);
  if (!stores.length) return { serverTime: new Date().toISOString(), stores, ros: [], lines: [], open: null };
  const ros = await soft<{ id: string; number: string | null; summary: string; status: string; job_id: string; location_id: string }>(
    pm.from('work_orders').select('id, number, summary, status, job_id, location_id').in('location_id', stores.map((s) => s.companyId)).in('kind', ['REPAIR_ORDER', 'PDI'])
      .in('status', ['SCHEDULED', 'DISPATCHED', 'IN_PROGRESS', 'ON_HOLD']).order('number', { ascending: false }).limit(150),
  );
  const [assigned, lines, open] = await Promise.all([
    me && ros.length ? soft<{ work_order_id: string }>(pm.from('dispatch_assignments').select('work_order_id').eq('employee_id', me).in('work_order_id', ros.map((r) => r.id)).neq('status', 'CANCELLED')) : Promise.resolve([]),
    ros.length
      ? soft<{ id: string; work_order_id: string; description: string; labor_op: string | null; flag_hours: number | string | null; status: string }>(
          pm.from('work_order_lines').select('id, work_order_id, description, labor_op, flag_hours, status').in('work_order_id', ros.map((r) => r.id)).in('kind', ['LABOR', 'SERVICE', 'SUBLET']).neq('status', 'DECLINED').order('sort'))
      : Promise.resolve([]),
    me ? soft<{ location_id: string; work_order_line_id: string | null; kind: string; started_at: string }>(pm.from('dlr_tech_punches').select('location_id, work_order_line_id, kind, started_at').eq('employee_id', me).is('ended_at', null).limit(1)) : Promise.resolve([]),
  ]);
  const mine = new Set(assigned.map((a) => a.work_order_id));
  const o = open[0];
  return {
    serverTime: new Date().toISOString(),
    stores,
    ros: ros.map((r) => ({ id: r.id, number: r.number, summary: r.summary, status: r.status, jobId: r.job_id, companyId: r.location_id, mine: mine.has(r.id) }))
      .sort((a, b) => Number(b.mine) - Number(a.mine)),
    lines: lines.map((l) => ({ id: l.id, workOrderId: l.work_order_id, description: l.description, laborOp: l.labor_op, flagHours: l.flag_hours == null ? null : Number(l.flag_hours), status: l.status })),
    open: o ? { companyId: o.location_id, lineId: o.work_order_line_id, kind: o.kind, startedAt: o.started_at } : null,
  };
}

// ------------------------------------------------------------------------------- installer pay

export interface PayTicket {
  id: string;
  number: string | null;
  jobId: string;
  job: string | null;
  completedOn: string;
  status: string;
  splitPct: number | null;
  grossCents: number | null;
  chargebackCents: number | null;
  netCents: number | null;
  lines: Array<{ laborCode: string; description: string | null; unit: string | null; qty: number; amountCents: number | null; overMeasured: boolean }>;
}

export interface PayWeek {
  installer: boolean;
  weekStart: string;
  weekEnd: string;
  tickets: PayTicket[];
  chargebacks: Array<{ id: string; reason: string; description: string | null; amountCents: number | null; status: string; createdAt: string }>;
  totals: { grossCents: number; chargebackCents: number; netCents: number; approvedNetCents: number };
}

/** "My pay this week": the installer's OWN tickets only (explicit employee filter on top of RLS). */
export async function loadPayWeek(db: SupabaseClient, userId: string, weekOf: string | null): Promise<PayWeek> {
  const weekStart = mondayOf(weekOf ?? todayIso());
  const weekEnd = addDays(weekStart, 6);
  const empty: PayWeek = { installer: false, weekStart, weekEnd, tickets: [], chargebacks: [], totals: { grossCents: 0, chargebackCents: 0, netCents: 0, approvedNetCents: 0 } };
  const me = await myEmployeeId(db, userId);
  if (!me) return empty;
  const pm = db.schema('pm');
  const tickets = await soft<{ id: string; number: string | null; job_id: string; employee_id: string | null; completed_on: string; split_pct: number | string | null; status: string; gross_cents: number | string | null; chargeback_cents: number | string | null; net_cents: number | string | null }>(
    pm.from('v_flr_pay_tickets_masked').select('id, number, job_id, employee_id, completed_on, split_pct, status, gross_cents, chargeback_cents, net_cents')
      .eq('employee_id', me).gte('completed_on', weekStart).lte('completed_on', weekEnd).neq('status', 'VOID').order('completed_on'),
  );
  const own = tickets.filter((t) => t.employee_id === me);
  const [lines, chargebacks, jobs] = await Promise.all([
    own.length ? soft<{ ticket_id: string; labor_code: string; description: string | null; unit: string | null; qty: number | string; amount_cents: number | string | null; over_measured: boolean | null }>(
      pm.from('v_flr_pay_ticket_lines_masked').select('ticket_id, labor_code, description, unit, qty, amount_cents, over_measured').in('ticket_id', own.map((t) => t.id)).order('line_no')) : Promise.resolve([]),
    soft<{ id: string; employee_id: string | null; reason: string; description: string | null; amount_cents: number | string | null; status: string; created_at: string }>(
      pm.from('v_flr_chargebacks_masked').select('id, employee_id, reason, description, amount_cents, status, created_at').eq('employee_id', me).in('status', ['PROPOSED', 'ACKNOWLEDGED']).order('created_at', { ascending: false }).limit(50)),
    own.length ? soft<{ job_id: string; job_number: string | null; name: string }>(pm.from('v_project_list').select('job_id, job_number, name').in('job_id', [...new Set(own.map((t) => t.job_id))])) : Promise.resolve([]),
  ]);
  if (!own.length && !chargebacks.length) return { ...empty, installer: true };
  const n = (v: number | string | null | undefined) => (v == null ? null : Number(v));
  const jobBy = new Map(jobs.map((j) => [j.job_id, [j.job_number, j.name].filter(Boolean).join(' · ')]));
  const out: PayTicket[] = own.map((t) => ({
    id: t.id, number: t.number, jobId: t.job_id, job: jobBy.get(t.job_id) ?? null, completedOn: t.completed_on, status: t.status,
    splitPct: n(t.split_pct), grossCents: n(t.gross_cents), chargebackCents: n(t.chargeback_cents), netCents: n(t.net_cents),
    lines: lines.filter((l) => l.ticket_id === t.id).map((l) => ({ laborCode: l.labor_code, description: l.description, unit: l.unit, qty: Number(l.qty), amountCents: n(l.amount_cents), overMeasured: !!l.over_measured })),
  }));
  const sum = (f: (t: PayTicket) => number | null) => out.reduce((s, t) => s + (f(t) ?? 0), 0);
  return {
    installer: true, weekStart, weekEnd, tickets: out,
    chargebacks: chargebacks.filter((c) => c.employee_id === me).map((c) => ({ id: c.id, reason: c.reason, description: c.description, amountCents: n(c.amount_cents), status: c.status, createdAt: c.created_at })),
    totals: {
      grossCents: sum((t) => t.grossCents), chargebackCents: sum((t) => t.chargebackCents), netCents: sum((t) => t.netCents ?? t.grossCents),
      approvedNetCents: sum((t) => (t.status === 'APPROVED' || t.status === 'PAID' ? t.netCents ?? t.grossCents : 0)),
    },
  };
}
