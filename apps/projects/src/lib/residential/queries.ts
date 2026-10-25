import 'server-only';
/**
 * Server loaders for the residential screens (RLS client; masked views wherever 1119 masks a money
 * column, so cost / overhead / markup arrive as null for people who may not see them).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { one, pm, rows } from '@/lib/pm/db';
import type {
  AssemblyRow, CatalogItemRow, ChainStepRow, CoExposureRow, CommunityRow, DecisionItem, HomeProfileRow, HouseholdRow, InspectionRow,
  LotBoardRow, OptionRow, PaymentScheduleRow, PermitRow, PlanRow, ProposalLineRow, ProposalOptionRow, ProposalRow, ProtectionCheckRow,
  PurchaseAgreementRow, RrpRow, TradeConfirmationRow, WalkRow,
} from './types';

export const PROPOSAL_COLS = 'id, location_id, job_id, estimate_id, lead_id, customer_id, number, version, title, job_type_key, contract_type, fee_pct, fee_cents, gmp_cents, savings_split_pct, tax_contract_form, tax_rate, state_code, scope_narrative, inclusions, exclusions, terms, cancellation_notice, cancel_days, deposit_pct, deposit_cents, deposit_refundable, design_proposal_id, credit_to_build, retainer_credit_cents, schedule_template_key, planned_start, valid_until, status, base_price_cents, options_price_cents, allowance_cents, contingency_cents, contingency_pct, fee_total_cents, tax_cents, use_tax_cents, total_cents, grand_total_cents, cost_cents, overhead_cents, deposit_due_cents, sent_at, first_viewed_at, last_viewed_at, view_count, file_id, envelope_id, signed_at, signed_by_name, sign_method, accepted_at, declined_at, decline_reason, result, created_by, created_at, updated_at';
const LINE_COLS = 'id, proposal_id, option_id, catalog_item_id, assembly_id, cost_code_id, cost_type, room, description, qty, uom, waste_pct, unit_cost_cents, markup_pct, margin_pct, unit_price_cents, labor_rate_card_id, labor_hours, cost_cents, overhead_cents, price_cents, is_allowance, allowance_category, selection_titles, is_contingency, tax_category, client_visible, sort';
const SCHEDULE_COLS = 'id, job_id, proposal_id, seq, label, kind, pct, amount_cents, added_cents, trigger_ref, task_id, billing_task_id, requires_photo, requires_checklist, status, hold_reason, billing_request_id, deposit_request_id';

/** numeric columns arrive as strings from PostgREST; the screens want numbers. */
function num<T extends object>(r: T, keys: ReadonlyArray<keyof T>): T {
  const o = { ...r } as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k as string];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) o[k as string] = Number(v);
  }
  return o as T;
}
const PROPOSAL_NUM: ReadonlyArray<keyof ProposalRow> = ['fee_pct', 'fee_cents', 'gmp_cents', 'savings_split_pct', 'tax_rate', 'deposit_pct', 'deposit_cents', 'retainer_credit_cents',
  'base_price_cents', 'options_price_cents', 'allowance_cents', 'contingency_cents', 'contingency_pct', 'fee_total_cents', 'tax_cents', 'use_tax_cents', 'total_cents',
  'grand_total_cents', 'cost_cents', 'overhead_cents', 'deposit_due_cents'];
const LINE_NUM: ReadonlyArray<keyof ProposalLineRow> = ['qty', 'waste_pct', 'unit_cost_cents', 'markup_pct', 'margin_pct', 'unit_price_cents', 'labor_hours', 'cost_cents', 'overhead_cents', 'price_cents'];

export interface ProposalListItem extends Pick<ProposalRow, 'id' | 'location_id' | 'job_id' | 'number' | 'version' | 'title' | 'contract_type' | 'status' | 'total_cents' | 'grand_total_cents' | 'sent_at' | 'view_count' | 'last_viewed_at' | 'accepted_at' | 'valid_until' | 'updated_at'> {
  job_number: string | null;
  customer_name: string | null;
}

export async function listProposals(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<ProposalListItem[]> {
  if (!companyIds.length) return [];
  const ps = rows<ProposalRow>(await pm(db).from('v_res_proposals_masked')
    .select('id, location_id, job_id, number, version, title, contract_type, status, total_cents, grand_total_cents, sent_at, view_count, last_viewed_at, accepted_at, valid_until, updated_at')
    .in('location_id', [...companyIds]).neq('status', 'SUPERSEDED').order('updated_at', { ascending: false }).limit(500), 'proposals');
  const jobIds = [...new Set(ps.map((p) => p.job_id))];
  const jobs = jobIds.length
    ? rows<{ id: string; job_number: string; customer_name: string | null }>(await pm(db).from('v_core_jobs_masked').select('id, job_number, customer_name').in('id', jobIds.slice(0, 500)), 'jobs')
    : [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return ps.map((p) => ({ ...num(p, PROPOSAL_NUM), job_number: byId.get(p.job_id)?.job_number ?? null, customer_name: byId.get(p.job_id)?.customer_name ?? null }));
}

export interface ProposalBundle {
  proposal: ProposalRow;
  options: ProposalOptionRow[];
  lines: ProposalLineRow[];
  schedule: PaymentScheduleRow[];
  job: { id: string; job_number: string; name: string; customer_name: string | null } | null;
  snapshots: Array<{ version: number; total_cents: number; sent_at: string }>;
  envelope: { id: string; status: string; sent_at: string | null; completed_at: string | null } | null;
}

export async function loadProposal(db: SupabaseClient, id: string): Promise<ProposalBundle> {
  const p = one<ProposalRow>(await pm(db).from('v_res_proposals_masked').select(PROPOSAL_COLS).eq('id', id).maybeSingle(), 'proposal');
  if (!p) throw new HttpError(404, 'That proposal was not found.', 'NOT_FOUND');
  const [options, lines, schedule, job, snaps, env] = await Promise.all([
    pm(db).from('res_proposal_options').select('id, proposal_id, kind, group_key, tier, label, description, image_url, is_selected, sort').eq('proposal_id', id).order('sort'),
    pm(db).from('v_res_proposal_lines_masked').select(LINE_COLS).eq('proposal_id', id).order('sort'),
    pm(db).from('res_payment_schedule').select(SCHEDULE_COLS).eq('proposal_id', id).order('seq'),
    pm(db).from('v_core_jobs_masked').select('id, job_number, name, customer_name').eq('id', p.job_id).maybeSingle(),
    pm(db).from('res_proposal_snapshots').select('version, total_cents, sent_at').eq('proposal_id', id).order('version', { ascending: false }),
    p.envelope_id ? pm(db).from('esign_envelopes').select('id, status, sent_at, completed_at').eq('id', p.envelope_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  return {
    proposal: num(p, PROPOSAL_NUM),
    options: rows<ProposalOptionRow>(options, 'options'),
    lines: rows<ProposalLineRow>(lines, 'lines').map((l) => num(l, LINE_NUM)),
    // payment schedule is contract_value on the job: people without it read no rows
    schedule: rows<PaymentScheduleRow>(schedule, 'payment schedule').map((s) => num(s, ['pct', 'amount_cents', 'added_cents'])),
    job: one<ProposalBundle['job']>(job, 'job'),
    snapshots: rows<{ version: number; total_cents: number; sent_at: string }>(snaps, 'versions').map((s) => num(s, ['total_cents'])),
    envelope: one<ProposalBundle['envelope']>(env as { data: unknown; error: null }, 'signature request'),
  };
}

export async function loadCatalog(db: SupabaseClient, companyId: string): Promise<{ items: CatalogItemRow[]; assemblies: AssemblyRow[] }> {
  const [items, asm, parts] = await Promise.all([
    pm(db).from('v_res_catalog_items_masked').select('id, location_id, code, name, description, category, cost_code_id, cost_type, uom, unit_cost_cents, waste_pct, markup_pct, margin_pct, unit_price_cents, price_locked, supplier_sku, vendor_id, lead_time_days, labor_rate_card_id, labor_hours_per_unit, tax_category, is_active')
      .eq('location_id', companyId).eq('is_active', true).order('category').order('code').limit(2000),
    pm(db).from('res_assemblies').select('id, location_id, code, name, uom').eq('location_id', companyId).eq('is_active', true).order('code'),
    pm(db).from('res_assembly_items').select('assembly_id, catalog_item_id, qty_per_unit'),
  ]);
  const byAsm = new Map<string, Array<{ catalog_item_id: string; qty_per_unit: number }>>();
  for (const x of rows<{ assembly_id: string; catalog_item_id: string; qty_per_unit: string }>(parts, 'assembly items')) {
    byAsm.set(x.assembly_id, [...(byAsm.get(x.assembly_id) ?? []), { catalog_item_id: x.catalog_item_id, qty_per_unit: Number(x.qty_per_unit) }]);
  }
  return {
    items: rows<CatalogItemRow>(items, 'catalog').map((i) => num(i, ['unit_cost_cents', 'waste_pct', 'markup_pct', 'margin_pct', 'unit_price_cents', 'labor_hours_per_unit'])),
    assemblies: rows<Omit<AssemblyRow, 'items'>>(asm, 'assemblies').map((a) => ({ ...a, items: byAsm.get(a.id) ?? [] })),
  };
}

export interface HomeWorkspace {
  job: { id: string; job_number: string; name: string; customer_name: string | null; location_id: string } | null;
  profile: HomeProfileRow | null;
  rrp: RrpRow | null;
  household: HouseholdRow[];
  checks: ProtectionCheckRow[];
  chainSteps: ChainStepRow[];
  walks: WalkRow[];
  permits: PermitRow[];
  inspections: InspectionRow[];
  changeOrders: CoExposureRow[];
  trades: TradeConfirmationRow[];
  schedule: PaymentScheduleRow[];
  decisions: DecisionItem[];
  vendors: Record<string, string>;
}

export async function loadHomeWorkspace(db: SupabaseClient, jobId: string): Promise<HomeWorkspace> {
  const job = one<HomeWorkspace['job']>(await pm(db).from('v_core_jobs_masked').select('id, job_number, name, customer_name, location_id').eq('id', jobId).maybeSingle(), 'job');
  if (!job) throw new HttpError(404, 'That job was not found or is not one of yours.', 'NOT_FOUND');
  const [profile, rrp, household, checks, chains, walks, permits, inspections, cos, trades, schedule, decisions] = await Promise.all([
    pm(db).from('res_home_profiles').select('*').eq('job_id', jobId).maybeSingle(),
    pm(db).from('res_rrp_records').select('*').eq('job_id', jobId).maybeSingle(),
    pm(db).from('res_household_members').select('id, contact_id, name, email, phone, relation, can_sign, can_pay, portal_status').eq('job_id', jobId).order('created_at'),
    pm(db).from('res_protection_checks').select('id, kind, check_date, items, photo_document_ids, status').eq('job_id', jobId).order('check_date', { ascending: false }).limit(30),
    pm(db).from('res_chains').select('id').eq('job_id', jobId).neq('status', 'CANCELLED'),
    pm(db).from('res_walks').select('id, kind, due_on, status, punch_created, accepted_by_name, accepted_at').eq('job_id', jobId).order('due_on'),
    pm(db).from('v_res_permits_masked').select('id, kind, number, authority, status, applied_on, issued_on, expires_on, delivered_on, removal_on, notes').eq('job_id', jobId).order('created_at'),
    pm(db).from('res_inspections').select('id, permit_id, kind, task_id, requested_on, scheduled_on, result, result_on, inspector, notes, reinspect_of').eq('job_id', jobId).order('requested_on', { ascending: false }),
    pm(db).from('v_res_co_exposure').select('id, job_id, number, title, co_type, stage, reason_code, stop_work, emergency, signed_at, signer_name, age_days, exposure_state, work_logged_unsigned').eq('job_id', jobId).order('created_at', { ascending: false }),
    pm(db).from('v_res_trade_confirmations').select('id, job_id, task_id, task_title, start_on, vendor_id, status, proposed_on, response_note, at_risk, date_moved_since_confirm').eq('job_id', jobId).order('start_on'),
    pm(db).from('res_payment_schedule').select(SCHEDULE_COLS).eq('job_id', jobId).order('seq'),
    pm(db).rpc('res_decision_queue', { p_job: jobId }),
  ]);
  const chainIds = rows<{ id: string }>(chains, 'chains').map((c) => c.id);
  const steps = chainIds.length
    ? rows<ChainStepRow>(await pm(db).from('res_chain_steps').select('id, chain_id, seq, step_key, label, vendor_id, lead_days, planned_on, actual_on, status, homeowner_visible, homeowner_label').in('chain_id', chainIds).order('seq'), 'chain steps')
    : [];
  const tradeRows = rows<TradeConfirmationRow>(trades, 'trade confirmations');
  const vendorIds = [...new Set(tradeRows.map((t) => t.vendor_id))];
  const vendors = vendorIds.length
    ? Object.fromEntries(rows<{ id: string; name: string }>(await pm(db).from('v_core_vendors_masked').select('id, name').in('id', vendorIds), 'vendors').map((v) => [v.id, v.name]))
    : {};
  return {
    job,
    profile: one<HomeProfileRow>(profile, 'home profile'),
    rrp: one<RrpRow>(rrp, 'RRP record'),
    household: rows<HouseholdRow>(household, 'household'),
    checks: rows<ProtectionCheckRow>(checks, 'protection checks'),
    chainSteps: steps,
    walks: rows<WalkRow>(walks, 'walks'),
    permits: rows<PermitRow>(permits, 'permits'),
    inspections: rows<InspectionRow>(inspections, 'inspections'),
    changeOrders: rows<CoExposureRow>(cos, 'change orders'),
    trades: tradeRows,
    schedule: rows<PaymentScheduleRow>(schedule, 'payment schedule').map((s) => num(s, ['pct', 'amount_cents', 'added_cents'])),
    decisions: decisions.error ? [] : ((decisions.data ?? []) as DecisionItem[]),
    vendors,
  };
}

export interface BuilderBundle {
  communities: CommunityRow[];
  lots: LotBoardRow[];
  plans: PlanRow[];
  options: OptionRow[];
  specs: Array<{ lot_id: string; lot_number: string; list_price_cents: number | null; days_on_market: number | null; aging: boolean }>;
}

export async function loadBuilder(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<BuilderBundle> {
  if (!companyIds.length) return { communities: [], lots: [], plans: [], options: [], specs: [] };
  const ids = [...companyIds];
  const [c, l, p, o, s] = await Promise.all([
    pm(db).from('res_communities').select('id, location_id, code, name, city, state, status').in('location_id', ids).order('name'),
    pm(db).from('v_res_starts_board').select('lot_id, location_id, community_id, community, lot_number, block, status, is_spec, plan_id, plan_code, plan_name, standard_cycle_days, job_id, started_on, completed_on, cycle_days, current_stage, pct_complete, behind_standard').in('location_id', ids).order('community').order('lot_number').limit(2000),
    pm(db).from('v_res_plans_masked').select('id, location_id, code, name, beds, baths, sqft, base_cost_cents, target_margin_pct, standard_cycle_days, schedule_template_key, job_type_key, is_active').in('location_id', ids).order('code'),
    pm(db).from('v_res_options_masked').select('id, location_id, code, name, category, cutoff_stage, is_structural, cost_cents, is_active').in('location_id', ids).order('category').order('code'),
    pm(db).from('v_res_spec_inventory').select('lot_id, lot_number, list_price_cents, days_on_market, aging').in('location_id', ids),
  ]);
  return {
    communities: rows<CommunityRow>(c, 'communities'),
    lots: rows<LotBoardRow>(l, 'lots').map((x) => num(x, ['pct_complete'])),
    plans: rows<PlanRow>(p, 'plans').map((x) => num(x, ['beds', 'baths', 'base_cost_cents', 'target_margin_pct'])),
    options: rows<OptionRow>(o, 'options').map((x) => num(x, ['cost_cents'])),
    specs: rows<BuilderBundle['specs'][number]>(s, 'spec inventory'),
  };
}

export async function loadLot(db: SupabaseClient, lotId: string): Promise<{ lot: Record<string, unknown>; agreement: PurchaseAgreementRow | null; paOptions: Array<{ option_id: string; price_cents: number; status: string }>; addenda: Array<{ id: string; seq: number; change_cents: number; late_fee_cents: number; status: string; lines: unknown[] }>; packageItems: Array<{ id: string; release_stage: string; scope: string; amount_cents: number; status: string; vendor_id: string | null; commitment_id: string | null }>; elevations: Array<{ id: string; plan_id: string; code: string; name: string; premium_cents: number }>; }> {
  const lot = one<Record<string, unknown>>(await pm(db).from('v_res_lots_masked').select('*').eq('id', lotId).maybeSingle(), 'lot');
  if (!lot) throw new HttpError(404, 'That lot was not found.', 'NOT_FOUND');
  const [pa, items, elev] = await Promise.all([
    pm(db).from('res_purchase_agreements').select('*').eq('lot_id', lotId).neq('status', 'CANCELLED').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    pm(db).from('res_start_package_items').select('id, release_stage, scope, amount_cents, status, vendor_id, commitment_id').eq('lot_id', lotId).order('release_stage'),
    lot.plan_id ? pm(db).from('res_elevations').select('id, plan_id, code, name, premium_cents').eq('plan_id', lot.plan_id as string) : Promise.resolve({ data: [], error: null }),
  ]);
  const agreement = one<PurchaseAgreementRow>(pa, 'purchase agreement');
  const [paOpts, addenda] = agreement
    ? await Promise.all([
        pm(db).from('res_pa_options').select('option_id, price_cents, status').eq('agreement_id', agreement.id),
        pm(db).from('res_pa_addenda').select('id, seq, change_cents, late_fee_cents, status, lines').eq('agreement_id', agreement.id).order('seq'),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  return {
    lot,
    agreement,
    paOptions: rows<{ option_id: string; price_cents: number; status: string }>(paOpts, 'agreement options'),
    addenda: rows<{ id: string; seq: number; change_cents: number; late_fee_cents: number; status: string; lines: unknown[] }>(addenda, 'addenda'),
    packageItems: rows(items as { data: unknown; error: null }, 'start package'),
    elevations: rows(elev as { data: unknown; error: null }, 'elevations'),
  };
}

export interface OpenLead { id: string; location_id: string; title: string; estimated_value_cents: number | null }

/** Open leads (not won, lost or converted) a proposal can start from. */
export async function listOpenLeads(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<OpenLead[]> {
  if (!companyIds.length) return [];
  const r = await db.schema('crm').from('leads').select('id, location_id, title, estimated_value_cents')
    .in('location_id', [...companyIds]).is('won_at', null).is('lost_at', null).is('converted_job_id', null).order('updated_at', { ascending: false }).limit(300);
  if (r.error) return [];
  return ((r.data ?? []) as OpenLead[]).map((l) => num(l, ['estimated_value_cents']));
}
