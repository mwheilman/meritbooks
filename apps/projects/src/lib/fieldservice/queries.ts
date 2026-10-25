import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { rows } from '@/lib/pm/db';
import {
  BOOKING_TYPE_COLS, BU_COLS, CALL_COLS, CAMPAIGN_COLS, CAPACITY_COLS, FINANCING_COLS, FS_ESTIMATE_COLS, FS_OPTION_COLS,
  FS_OPTION_ITEM_COLS, PRICEBOOK_COLS, TEMPLATE_COLS, WINDOW_COLS, ZONE_COLS,
  type AgreementTemplateRow, type BillingScheduleRow, type BookingJobTypeRow, type BusinessUnitRow, type CallRow, type CampaignReportRow,
  type CampaignRow, type CapacityCell, type CapacityLimitRow, type DeferredRow, type EligibleTech, type FinancingPlanRow,
  type FsEstimateRow, type FsOptionItemRow, type FsOptionRow, type MarkupTierRow, type OnCallRow, type OptionTotalsRow,
  type PrejobBrief, type PricebookCategoryRow, type PricebookItemRow, type PricebookSettingsRow, type RenewalRow, type ScorecardRow,
  type TechEventRow, type VisitDueRow, type WindowRow, type ZoneRow,
} from './types';

const pm = (db: SupabaseClient) => db.schema('pm');
const ids = (xs: ReadonlyArray<string>) => [...xs].slice(0, 200);

/** Rows or [] when the table is not readable for this caller (a class policy simply returns none). */
async function soft<T>(p: PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>): Promise<T[]> {
  const r = await p;
  if (r.error) return [];
  return (r.data ?? []) as T[];
}

export interface BookingSetup {
  businessUnits: BusinessUnitRow[];
  zones: ZoneRow[];
  windows: WindowRow[];
  campaigns: CampaignRow[];
  jobTypes: BookingJobTypeRow[];
  templates: AgreementTemplateRow[];
}

export async function loadBookingSetup(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<BookingSetup> {
  if (!companyIds.length) return { businessUnits: [], zones: [], windows: [], campaigns: [], jobTypes: [], templates: [] };
  const c = ids(companyIds);
  const [businessUnits, zones, windows, campaigns, jobTypes, templates] = await Promise.all([
    rows<BusinessUnitRow>(await pm(db).from('business_units').select(BU_COLS).in('location_id', c).order('sort').order('code'), 'business units'),
    rows<ZoneRow>(await pm(db).from('service_zones').select(ZONE_COLS).in('location_id', c).order('sort').order('code'), 'zones'),
    rows<WindowRow>(await pm(db).from('arrival_windows').select(WINDOW_COLS).in('location_id', c).order('sort').order('start_time'), 'arrival windows'),
    rows<CampaignRow>(await pm(db).from('campaigns').select(CAMPAIGN_COLS).in('location_id', c).order('name'), 'campaigns'),
    rows<BookingJobTypeRow>(await pm(db).from('booking_job_types').select(BOOKING_TYPE_COLS).in('location_id', c).order('sort').order('label'), 'job types'),
    rows<AgreementTemplateRow>(await pm(db).from('agreement_templates').select(TEMPLATE_COLS).in('location_id', c).eq('is_active', true).order('sort'), 'plans'),
  ]);
  return { businessUnits, zones, windows, campaigns, jobTypes, templates };
}

export async function loadCalls(db: SupabaseClient, companyIds: ReadonlyArray<string>, limit = 60): Promise<{ recent: CallRow[]; requests: CallRow[] }> {
  if (!companyIds.length) return { recent: [], requests: [] };
  const c = ids(companyIds);
  const [recent, requests] = await Promise.all([
    soft<CallRow>(pm(db).from('service_calls').select(CALL_COLS).in('location_id', c).neq('status', 'REQUEST').order('created_at', { ascending: false }).limit(limit)),
    soft<CallRow>(pm(db).from('service_calls').select(CALL_COLS).in('location_id', c).eq('status', 'REQUEST').order('created_at').limit(200)),
  ]);
  return { recent, requests };
}

export async function loadCapacityGrid(db: SupabaseClient, companyId: string, from: string, days: number): Promise<CapacityCell[]> {
  const r = await pm(db).rpc('fs_capacity_grid', { p_location: companyId, p_from: from, p_days: days, p_business_unit: null, p_zone: null });
  if (r.error) return [];
  return (r.data ?? []) as CapacityCell[];
}

export async function loadCapacityLimits(db: SupabaseClient, companyId: string): Promise<CapacityLimitRow[]> {
  return soft<CapacityLimitRow>(pm(db).from('capacity_limits').select(CAPACITY_COLS).eq('location_id', companyId).order('on_date', { nullsFirst: true }).limit(2000));
}

export interface PricebookData {
  items: PricebookItemRow[];
  categories: PricebookCategoryRow[];
  businessUnits: BusinessUnitRow[];
  settings: PricebookSettingsRow | null;
  tiers: MarkupTierRow[];
  bundles: Array<{ service_item_id: string; material_item_id: string; qty: number }>;
  plans: FinancingPlanRow[];
  capped: boolean;
}

export async function loadPricebook(db: SupabaseClient, companyId: string, cap = 3000): Promise<PricebookData> {
  const [itemsRes, categories, businessUnits, settings, tiers, plans] = await Promise.all([
    pm(db).from('v_price_book_items_masked').select(PRICEBOOK_COLS, { count: 'exact' }).eq('location_id', companyId).order('code').limit(cap),
    rows<PricebookCategoryRow>(await pm(db).from('pricebook_categories').select('id, location_id, code, name, trade, sort').eq('location_id', companyId).order('sort'), 'categories'),
    rows<BusinessUnitRow>(await pm(db).from('business_units').select(BU_COLS).eq('location_id', companyId).order('sort'), 'business units'),
    soft<PricebookSettingsRow>(pm(db).from('pricebook_settings').select('id, location_id, burdened_rate_cents, target_gm_pct, equipment_gm_pct, member_discount_pct, after_hours_multiplier, rounding, price_floor_gm_pct').eq('location_id', companyId).limit(1)),
    soft<MarkupTierRow>(pm(db).from('pricebook_markup_tiers').select('id, location_id, up_to_cents, markup_pct').eq('location_id', companyId)),
    soft<FinancingPlanRow>(pm(db).from('v_financing_plans_masked').select(FINANCING_COLS).eq('location_id', companyId).order('term_months')),
  ]);
  const items = rows<PricebookItemRow>(itemsRes, 'price book');
  const serviceIds = items.filter((i) => i.kind === 'SERVICE').map((i) => i.id);
  const bundles = serviceIds.length
    ? await soft<{ service_item_id: string; material_item_id: string; qty: number }>(pm(db).from('pricebook_service_materials').select('service_item_id, material_item_id, qty').in('service_item_id', serviceIds.slice(0, 1500)))
    : [];
  return { items, categories, businessUnits, settings: settings[0] ?? null, tiers, bundles, plans, capped: (itemsRes.count ?? 0) > items.length };
}

export interface VisitData {
  brief: PrejobBrief | null;
  estimates: FsEstimateRow[];
  options: FsOptionRow[];
  items: FsOptionItemRow[];
  totals: OptionTotalsRow[];
  pricebook: Array<Pick<PricebookItemRow, 'id' | 'code' | 'name' | 'kind' | 'price_cents' | 'member_price_cents' | 'category_id' | 'gbb_tier' | 'customer_description'>>;
  plans: FinancingPlanRow[];
  templates: AgreementTemplateRow[];
  eligible: EligibleTech[];
}

export async function loadVisit(db: SupabaseClient, woId: string, companyId: string, opts: { eligible: boolean }): Promise<VisitData> {
  const [briefRes, estimates, pricebook, plans, templates, eligibleRes] = await Promise.all([
    pm(db).rpc('fs_prejob_brief', { p_wo: woId }),
    soft<FsEstimateRow>(pm(db).from('fs_estimates').select(FS_ESTIMATE_COLS).eq('work_order_id', woId).order('created_at', { ascending: false }).limit(20)),
    soft<VisitData['pricebook'][number]>(pm(db).from('v_price_book_items_masked').select('id, code, name, kind, price_cents, member_price_cents, category_id, gbb_tier, customer_description').eq('location_id', companyId).eq('is_active', true).order('code').limit(3000)),
    soft<FinancingPlanRow>(pm(db).from('v_financing_plans_masked').select(FINANCING_COLS).eq('location_id', companyId).eq('is_active', true).order('term_months')),
    soft<AgreementTemplateRow>(pm(db).from('agreement_templates').select(TEMPLATE_COLS).eq('location_id', companyId).eq('is_active', true).order('sort')),
    opts.eligible ? pm(db).rpc('fs_eligible_techs', { p_wo: woId, p_start: null, p_end: null }) : Promise.resolve({ data: [], error: null }),
  ]);
  const estIds = estimates.map((e) => e.id);
  const options = estIds.length ? await soft<FsOptionRow>(pm(db).from('fs_estimate_options').select(FS_OPTION_COLS).in('estimate_id', estIds).order('sort')) : [];
  const optIds = options.map((o) => o.id);
  const [items, totals] = optIds.length
    ? await Promise.all([
        soft<FsOptionItemRow>(pm(db).from('v_fs_estimate_option_items_masked').select(FS_OPTION_ITEM_COLS).in('option_id', optIds).order('sort')),
        soft<OptionTotalsRow>(pm(db).from('v_fs_option_totals').select('option_id, estimate_id, regular_cents, member_cents, rebate_cents').in('option_id', optIds)),
      ])
    : [[] as FsOptionItemRow[], [] as OptionTotalsRow[]];
  return {
    brief: briefRes.error ? null : (briefRes.data as PrejobBrief),
    estimates, options, items, totals, pricebook, plans, templates,
    eligible: eligibleRes.error ? [] : ((eligibleRes.data ?? []) as EligibleTech[]),
  };
}

export interface AgreementsWorkspaceData {
  visitsDue: VisitDueRow[];
  renewals: RenewalRow[];
  deferred: DeferredRow[];
  schedule: BillingScheduleRow[];
  templates: AgreementTemplateRow[];
  imports: Array<{ id: string; created_at: string; source_system: string; dry_run: boolean; row_count: number; ok_count: number; error_count: number; deferred_cents: number; visits_owed: number }>;
}

export async function loadAgreementsWorkspace(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<AgreementsWorkspaceData> {
  if (!companyIds.length) return { visitsDue: [], renewals: [], deferred: [], schedule: [], templates: [], imports: [] };
  const c = ids(companyIds);
  const [visitsDue, renewals, deferred, schedule, templates, imports] = await Promise.all([
    soft<VisitDueRow>(pm(db).from('v_fs_visits_due').select('*').in('location_id', c).order('due_on', { nullsFirst: false }).limit(2000)),
    soft<RenewalRow>(pm(db).from('v_fs_renewals').select('*').in('location_id', c).order('ends_on').limit(1000)),
    soft<DeferredRow>(pm(db).from('v_fs_agreement_deferred').select('*').in('location_id', c).limit(2000)),
    soft<BillingScheduleRow>(pm(db).from('agreement_billing_schedule').select('id, agreement_id, period_no, period_start, period_end, bill_on, amount_cents, status, billing_request_id, attempts').lte('bill_on', new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10)).order('bill_on', { ascending: false }).limit(2000)),
    soft<AgreementTemplateRow>(pm(db).from('agreement_templates').select(TEMPLATE_COLS).in('location_id', c).order('sort')),
    soft<AgreementsWorkspaceData['imports'][number]>(pm(db).from('agreement_imports').select('id, created_at, source_system, dry_run, row_count, ok_count, error_count, deferred_cents, visits_owed').in('location_id', c).order('created_at', { ascending: false }).limit(20)),
  ]);
  return { visitsDue, renewals, deferred, schedule, templates, imports };
}

export async function loadScorecard(db: SupabaseClient, companyId: string, from: string, to: string): Promise<{ rows: ScorecardRow[]; error: string | null }> {
  const r = await pm(db).rpc('fs_tech_scorecard', { p_location: companyId, p_from: from, p_to: to });
  if (r.error) return { rows: [], error: r.error.message ?? 'Scorecards did not load.' };
  return { rows: (r.data ?? []) as ScorecardRow[], error: null };
}

export async function loadCampaignReport(db: SupabaseClient, companyId: string, from: string, to: string): Promise<{ rows: CampaignReportRow[]; error: string | null }> {
  const r = await pm(db).rpc('fs_campaign_report', { p_location: companyId, p_from: from, p_to: to });
  if (r.error) return { rows: [], error: r.error.message ?? 'The campaign report did not load.' };
  return { rows: (r.data ?? []) as CampaignReportRow[], error: null };
}

export async function loadReviews(db: SupabaseClient, companyId: string): Promise<Array<{ id: string; employee_id: string | null; status: string; rating: number | null; created_at: string; work_order_id: string }>> {
  return soft(pm(db).from('fs_review_requests').select('id, employee_id, status, rating, created_at, work_order_id').eq('location_id', companyId).order('created_at', { ascending: false }).limit(500));
}

export async function loadDispatchExtras(db: SupabaseClient, companyIds: ReadonlyArray<string>, dayFrom: string, dayTo: string): Promise<{ events: TechEventRow[]; onCall: OnCallRow[] }> {
  if (!companyIds.length) return { events: [], onCall: [] };
  const c = ids(companyIds);
  const [events, onCall] = await Promise.all([
    soft<TechEventRow>(pm(db).from('tech_events').select('id, location_id, employee_id, kind, slot, note').in('location_id', c).overlaps('slot', `[${dayFrom},${dayTo})`).limit(500)),
    soft<OnCallRow>(pm(db).from('on_call_shifts').select('id, location_id, business_unit_id, employee_id, role, starts_at, ends_at').in('location_id', c).lt('starts_at', dayTo).gt('ends_at', dayFrom).order('starts_at').limit(200)),
  ]);
  return { events, onCall };
}
