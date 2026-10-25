import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PgErrorLike } from '@/lib/api-errors';
import { cmError, cmRpc } from './server';
import { redactPrivacyCase } from './screen-logic';
import type { CalendarRow, CostDetailRow, PayableRetainageRow, RetainageBothRow, SheetLine, BuyoutPackage, Assignment, CrewRequest } from './screen-logic';
import type {
  ChecklistTemplate, CloseoutItem, CommitmentMoney, CompanyProfile, ContractSettings, CostCodeLite, CostCodeUnit, Correspondence, DirectoryEntry, EnvelopeLite,
  FadeAlert, G702Row, Incident, Inspection, InstalledQty, Jha, Observation, PayAppListRow, PayAppPreview, PayAppRevision, PayAppStatusRow, PayAppWorkspaceData,
  ProjectTemplate, ReviewPackage, SpecSection, TemplateApplication, ToolboxTalk, TradeProposal, Transmittal,
} from './screen-types';

/**
 * Server loaders for the Wave C commercial screens: the RLS client only, money through the
 * masked views (RLS narrows what each caller sees), every PG error mapped to a plain sentence.
 */

type Res = { data: unknown; error: PgErrorLike | null };
const pm = (db: SupabaseClient) => db.schema('pm');
const ids = (xs: ReadonlyArray<string>) => [...new Set(xs)].slice(0, 400);

function list<T>(r: Res): T[] {
  if (r.error) throw cmError(r.error);
  return (r.data ?? []) as T[];
}
function soft<T>(r: Res): T[] {
  return r.error ? [] : ((r.data ?? []) as T[]);
}

// ------------------------------------------------------------------ directory (CGC-04)

const PROFILE_COLS = 'id, location_id, vendor_id, customer_id, csi_divisions, trades, licenses, union_local, dbe, mbe, wbe, sdvob, emr, emr_year, bonding_single_cents, bonding_aggregate_cents, prequal_status, prequal_expires, notes';

export async function loadDirectory(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ entries: DirectoryEntry[]; profiles: CompanyProfile[]; vendors: Array<{ id: string; name: string }> }> {
  const [entries, profiles, vendors] = await Promise.all([
    jobIds.length ? pm(db).from('cm_v_project_directory').select('*').in('job_id', ids(jobIds)).order('party_role').order('company_name').limit(2000) : Promise.resolve({ data: [], error: null }),
    pm(db).from('cm_company_profiles').select(PROFILE_COLS).limit(2000),
    pm(db).from('v_core_vendors_masked').select('id, name, display_name').order('name').limit(1000),
  ]);
  return {
    entries: list<DirectoryEntry>(entries),
    profiles: list<CompanyProfile>(profiles),
    vendors: soft<{ id: string; name: string; display_name: string | null }>(vendors).map((v) => ({ id: v.id, name: v.display_name || v.name })),
  };
}

// ------------------------------------------------------------------ templates (CGC-06)

export async function loadTemplates(db: SupabaseClient): Promise<{ templates: ProjectTemplate[]; applications: TemplateApplication[] }> {
  const [t, a] = await Promise.all([
    pm(db).from('cm_project_templates').select('id, location_id, key, name, kind, description, version, payload, is_active, updated_at').order('name'),
    pm(db).from('cm_template_applications').select('job_id, template_id, version, applied_at').limit(5000),
  ]);
  return { templates: list<ProjectTemplate>(t), applications: soft<TemplateApplication>(a) };
}

// ------------------------------------------------------------------ trade proposals (CGC-25)

const PROPOSAL_COLS = 'id, location_id, customer_id, number, project_name, base_bid_cents, alternates, unit_prices, inclusions, exclusions, qualifications, schedule_assumptions, valid_until, status, sent_at, accepted_at, job_id, created_at';

export async function loadProposals(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<TradeProposal[]> {
  // the masked view: base bid, alternate and unit-price amounts null unless contract value or estimating at the company (1120 L3)
  let q = pm(db).from('v_cm_proposals_masked').select(PROPOSAL_COLS).neq('status', 'VOID');
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return list<TradeProposal>(await q.order('created_at', { ascending: false }).limit(500));
}

export async function loadCustomers(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<Array<{ id: string; name: string }>> {
  void companyIds;
  const r = await pm(db).from('v_core_customers_masked').select('id, name, display_name').order('name').limit(1000);
  return soft<{ id: string; name: string; display_name: string | null }>(r).map((c) => ({ id: c.id, name: c.display_name || c.name }));
}

// ------------------------------------------------------------------ buyout (CGC-30)

export async function loadBuyout(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<BuyoutPackage[]> {
  if (!jobIds.length) return [];
  return list<BuyoutPackage>(await pm(db).from('cm_v_buyout').select('package_id, job_id, name, csi_division, status, sort, lead_time_days, budget_cents, committed_cents, need_by, days_to_need').in('job_id', ids(jobIds)).order('sort').limit(2000));
}

// ------------------------------------------------------------------ owner pay apps (CGC-41/43/44)

const G702_COLS = 'job_id, billing_request_id, application_no, period_end, status, original_contract_cents, net_change_by_co_cents, contract_sum_to_date_cents, total_completed_stored_cents, retainage_work_cents, retainage_stored_cents, retainage_total_cents, total_earned_less_retainage_cents, previous_certificates_cents, current_payment_due_cents, balance_to_finish_incl_retainage_cents, request_net_cents';
const STATUS_COLS = 'id, job_id, billing_request_id, application_no, revision, stage, pencil_sent_at, pencil_sent_to, returned_note, architect_name, certified_at, certified_amount_cents, certified_by, contractor_signed_at, notarized_at, owner_approved_at, portal, portal_status, portal_submitted_at, superseded_by';
const LINE_COLS = 'id, line_no, sort, line_type, description, sov_line_id, scheduled_value_cents, previous_work_cents, this_period_work_cents, stored_materials_cents, previous_stored_cents, total_completed_cents, pct_complete, balance_to_finish_cents, retainage_rate, retainage_work_to_date_cents, retainage_stored_to_date_cents, retainage_this_period_cents';

export async function loadPayApps(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<PayAppListRow[]> {
  if (!jobIds.length) return [];
  const j = ids(jobIds);
  const [apps, st] = await Promise.all([
    pm(db).from('v_pay_application').select(G702_COLS).in('job_id', j).order('application_no', { ascending: false }).limit(1000),
    pm(db).from('cm_pay_app_status').select(STATUS_COLS).in('job_id', j).limit(2000),
  ]);
  const byReq = new Map(soft<PayAppStatusRow>(st).map((s) => [s.billing_request_id, s]));
  return list<G702Row>(apps).map((a) => {
    const s = byReq.get(a.billing_request_id);
    return { ...a, stage: s?.stage ?? (a.status === 'DRAFT' ? 'PENCIL' : a.status === 'VOID' ? 'VOID' : 'FINAL'), revision: s?.revision ?? 1, portal: s?.portal ?? null, portal_status: s?.portal_status ?? null };
  });
}

export async function loadPayAppWorkspace(db: SupabaseClient, requestId: string, jobLabel: (jobId: string) => string): Promise<PayAppWorkspaceData | null> {
  const req = await pm(db).from('billing_requests').select('id, job_id, status, period_end, application_no, billing_subtype').eq('id', requestId).maybeSingle();
  if (req.error) throw cmError(req.error);
  const r = req.data as { id: string; job_id: string; status: string; period_end: string | null; application_no: number | null; billing_subtype: string | null } | null;
  if (!r || r.billing_subtype !== 'SOV') return null;
  const [g702, lines, status, revisions, settings, steps, siblings, preview, docs] = await Promise.all([
    pm(db).from('v_pay_application').select(G702_COLS).eq('billing_request_id', requestId).maybeSingle(),
    pm(db).from('billing_request_lines').select(LINE_COLS).eq('billing_request_id', requestId).order('sort').order('line_no'),
    pm(db).from('cm_pay_app_status').select(STATUS_COLS).eq('billing_request_id', requestId).maybeSingle(),
    r.application_no != null ? pm(db).from('cm_pay_app_revisions').select('id, revision, reason, totals, lines, created_at').eq('job_id', r.job_id).eq('application_no', r.application_no).order('revision', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    pm(db).from('cm_contract_settings').select('billing_cutoff_day, billing_form, billing_portal_url, retainage_step_mode, stored_retainage_pct, architect_certification, notarization_required').eq('job_id', r.job_id).maybeSingle(),
    pm(db).from('cm_retainage_steps').select('from_pct, rate, note').eq('job_id', r.job_id).eq('side', 'RECEIVABLE').order('from_pct'),
    pm(db).from('billing_requests').select('id, application_no, status, period_end').eq('job_id', r.job_id).eq('billing_subtype', 'SOV').neq('status', 'VOID').order('application_no', { ascending: false }).limit(60),
    cmRpc<PayAppPreview | null>(db, 'cm_pay_app_preview', { p_request: requestId }, 'billing request').catch(() => null),
    pm(db).from('doc_files').select('id').eq('subject_table', 'billing_requests').eq('subject_id', requestId).limit(20),
  ]);
  const sheet = list<SheetLine>(lines);
  // which lines came from an approved change order (CGC-41: approved COs auto-added)
  const sovIds = sheet.map((l) => l.sov_line_id).filter((x): x is string => !!x);
  if (sovIds.length) {
    const sl = soft<{ id: string; change_order_id: string | null }>(await pm(db).from('sov_lines').select('id, change_order_id').in('id', ids(sovIds)));
    const coIds = sl.map((s) => s.change_order_id).filter((x): x is string => !!x);
    const cos = coIds.length ? soft<{ id: string; number: string | null }>(await pm(db).from('change_orders').select('id, number').in('id', ids(coIds))) : [];
    const coNo = new Map(cos.map((c) => [c.id, c.number ?? 'CO']));
    const bySov = new Map(sl.map((s) => [s.id, s.change_order_id ? coNo.get(s.change_order_id) ?? 'CO' : null]));
    for (const l of sheet) l.change_order = l.sov_line_id ? bySov.get(l.sov_line_id) ?? null : null;
  }
  const fileIds = soft<{ id: string }>(docs).map((d) => d.id);
  let envelopes: EnvelopeLite[] = [];
  if (fileIds.length) {
    const env = soft<{ id: string; status: string; title: string; sent_at: string | null; completed_at: string | null }>(
      await pm(db).from('esign_envelopes').select('id, status, title, sent_at, completed_at').in('file_id', fileIds).order('created_at', { ascending: false }).limit(10));
    const signers = env.length ? soft<{ envelope_id: string; name: string; status: string; signed_at: string | null; role_label: string | null }>(
      await pm(db).from('esign_signers').select('envelope_id, name, status, signed_at, role_label').in('envelope_id', env.map((e) => e.id))) : [];
    envelopes = env.map((e) => ({ ...e, signers: signers.filter((s) => s.envelope_id === e.id) }));
  }
  const statusRows = soft<{ billing_request_id: string; revision: number; stage: string }>(await pm(db).from('cm_pay_app_status').select('billing_request_id, revision, stage').eq('job_id', r.job_id));
  const stOf = new Map(statusRows.map((s) => [s.billing_request_id, s]));
  if (g702.error) throw cmError(g702.error);
  return {
    jobId: r.job_id,
    jobLabel: jobLabel(r.job_id),
    requestId: r.id,
    requestStatus: r.status,
    periodEnd: r.period_end,
    applicationNo: r.application_no,
    g702: (g702.data ?? null) as G702Row | null,
    lines: sheet,
    status: (status.data ?? null) as PayAppStatusRow | null,
    revisions: soft<PayAppRevision>(revisions),
    preview: preview ? { ...preview, preconditions: preview.preconditions ?? [], warnings: preview.warnings ?? [] } : null,
    settings: (settings.data ?? null) as ContractSettings | null,
    steps: soft<{ from_pct: number; rate: number; note: string | null }>(steps),
    envelopes,
    siblings: soft<{ id: string; application_no: number | null; status: string; period_end: string | null }>(siblings).map((s) => ({
      id: s.id, application_no: s.application_no, period_end: s.period_end, revision: stOf.get(s.id)?.revision ?? 1, stage: stOf.get(s.id)?.stage ?? (s.status === 'DRAFT' ? 'PENCIL' : 'FINAL'),
    })),
  };
}

/** Jobs with an ACTIVE schedule of values (the ones a pay application can be drafted on). */
export async function jobsWithActiveSov(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<string[]> {
  if (!jobIds.length) return [];
  return soft<{ job_id: string }>(await pm(db).from('sov_versions').select('job_id').in('job_id', ids(jobIds)).eq('status', 'ACTIVE')).map((r) => r.job_id);
}

// ------------------------------------------------------------------ retainage both sides (CGC-49)

export async function loadRetainageLedger(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ both: RetainageBothRow[]; payable: PayableRetainageRow[]; vendors: Record<string, string> }> {
  if (!jobIds.length) return { both: [], payable: [], vendors: {} };
  const j = ids(jobIds);
  const [both, pay] = await Promise.all([
    pm(db).from('cm_v_retainage_both').select('job_id, location_id, receivable_held_cents, receivable_released_cents, receivable_outstanding_cents, payable_held_cents, payable_released_cents, payable_outstanding_cents, substantial_completion_on, receivable_release_eligible').in('job_id', j),
    pm(db).from('cm_v_payable_retainage').select('job_id, location_id, commitment_id, number, vendor_id, held_cents, released_cents, outstanding_cents, final_waiver_verified').in('job_id', j),
  ]);
  const payable = list<PayableRetainageRow>(pay).filter((p) => Number(p.held_cents ?? 0) !== 0);
  const vids = payable.map((p) => p.vendor_id).filter((x): x is string => !!x);
  const vendors = vids.length ? soft<{ id: string; name: string; display_name: string | null }>(await pm(db).from('v_core_vendors_masked').select('id, name, display_name').in('id', ids(vids))) : [];
  return { both: list<RetainageBothRow>(both), payable, vendors: Object.fromEntries(vendors.map((v) => [v.id, v.display_name || v.name])) };
}

// ------------------------------------------------------------------ job cost drill-down (CGC-55)

export async function loadCostDetail(db: SupabaseClient, jobId: string, from: string | null, to: string | null, companyId: string): Promise<{ rows: CostDetailRow[]; codes: CostCodeLite[]; commitments: CommitmentMoney[]; vendors: Record<string, string> }> {
  const [rows, codes, cs, waivers] = await Promise.all([
    cmRpc<CostDetailRow[]>(db, 'cm_job_cost_detail', { p_job: jobId, p_from: from, p_to: to }, 'record'),
    pm(db).from('cost_codes').select('id, code, name').eq('location_id', companyId).limit(2000),
    pm(db).from('v_commitment_status').select('commitment_id, number, vendor_name, revised_amount_cents, billed_cents, open_cents').eq('job_id', jobId).limit(3000),
    pm(db).from('v_cm_lien_waivers_masked').select('commitment_id, amount_cents, paid_on, status').eq('job_id', jobId).not('paid_on', 'is', null).limit(3000),
  ]);
  const paid = new Map<string, number>();
  for (const w of soft<{ commitment_id: string | null; amount_cents: number | null; status: string }>(waivers)) {
    if (!w.commitment_id || w.status === 'VOID') continue;
    paid.set(w.commitment_id, (paid.get(w.commitment_id) ?? 0) + Number(w.amount_cents ?? 0));
  }
  const byC = new Map<string, CommitmentMoney>();
  for (const l of soft<{ commitment_id: string; number: string; vendor_name: string | null; revised_amount_cents: number | null; billed_cents: number | null; open_cents: number | null }>(cs)) {
    const c = byC.get(l.commitment_id) ?? { commitment_id: l.commitment_id, number: l.number, vendor_name: l.vendor_name, committed: 0, invoiced: 0, paid: paid.get(l.commitment_id) ?? 0, open: 0 };
    c.committed = (c.committed ?? 0) + Number(l.revised_amount_cents ?? 0);
    c.invoiced = (c.invoiced ?? 0) + Number(l.billed_cents ?? 0);
    c.open = (c.open ?? 0) + Number(l.open_cents ?? 0);
    byC.set(l.commitment_id, c);
  }
  const vids = [...new Set(rows.map((r) => r.vendor_id).filter((x): x is string => !!x))];
  const vendors = vids.length ? soft<{ id: string; name: string; display_name: string | null }>(await pm(db).from('v_core_vendors_masked').select('id, name, display_name').in('id', ids(vids))) : [];
  return { rows, codes: soft<CostCodeLite>(codes), commitments: [...byC.values()].sort((a, b) => a.number.localeCompare(b.number)), vendors: Object.fromEntries(vendors.map((v) => [v.id, v.display_name || v.name])) };
}

// ------------------------------------------------------------------ specifications (CGC-62)

export async function loadSpecs(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ sections: SpecSection[]; submittalsBySection: Record<string, number> }> {
  if (!jobIds.length) return { sections: [], submittalsBySection: {} };
  const j = ids(jobIds);
  const [s, sub] = await Promise.all([
    pm(db).from('cm_spec_sections').select('id, job_id, number, title, division, revision, addendum, document_id, page_start, page_end, updated_at').in('job_id', j).order('number').limit(5000),
    pm(db).from('cm_submittals').select('job_id, spec_section').in('job_id', j).neq('status', 'VOID').limit(5000),
  ]);
  const counts: Record<string, number> = {};
  for (const x of soft<{ job_id: string; spec_section: string | null }>(sub)) if (x.spec_section) counts[`${x.job_id}|${x.spec_section}`] = (counts[`${x.job_id}|${x.spec_section}`] ?? 0) + 1;
  return { sections: list<SpecSection>(s), submittalsBySection: counts };
}

// ------------------------------------------------------------------ transmittals / correspondence (CGC-67)

export async function loadCorrespondence(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ transmittals: Transmittal[]; letters: Correspondence[] }> {
  if (!jobIds.length) return { transmittals: [], letters: [] };
  const j = ids(jobIds);
  const [t, c] = await Promise.all([
    pm(db).from('cm_transmittals').select('id, job_id, number, subject, to_name, to_company, to_email, purpose, items, notes, status, sent_at, acknowledged_at, acknowledged_by, created_at').in('job_id', j).order('created_at', { ascending: false }).limit(500),
    pm(db).from('cm_correspondence').select('id, job_id, corr_type, number, direction, subject, body, from_name, to_name, to_company, sent_on, response_required_by, responded_on, status, change_event_id, created_at').in('job_id', j).order('created_at', { ascending: false }).limit(500),
  ]);
  return { transmittals: list<Transmittal>(t), letters: list<Correspondence>(c) };
}

// ------------------------------------------------------------------ inspections / observations (CGC-75/76)

export async function loadInspections(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ inspections: Inspection[]; templates: ChecklistTemplate[] }> {
  const [ins, tpl] = await Promise.all([
    jobIds.length ? pm(db).from('cm_inspections').select('id, job_id, template_id, number, title, category, area, inspected_on, inspector_name, status, result, signed_by_name, signed_at').in('job_id', ids(jobIds)).neq('status', 'VOID').order('inspected_on', { ascending: false }).limit(1000) : Promise.resolve({ data: [], error: null }),
    pm(db).from('cm_checklist_templates').select('id, name, category, items').eq('is_active', true).order('name').limit(300),
  ]);
  return { inspections: list<Inspection>(ins), templates: soft<ChecklistTemplate>(tpl) };
}

const OBS_COLS = 'id, job_id, number, obs_type, priority, title, description, hazard, contributing_condition, assignee_vendor_id, assignee_name, due_on, status, closed_at, inspection_item_id, created_at';

export async function loadObservations(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<Observation[]> {
  if (!jobIds.length) return [];
  return list<Observation>(await pm(db).from('cm_observations').select(OBS_COLS).in('job_id', ids(jobIds)).neq('status', 'VOID').order('created_at', { ascending: false }).limit(1500));
}

// ------------------------------------------------------------------ safety (CGC-78/79)

const INCIDENT_COLS = 'id, job_id, location_id, number, incident_type, occurred_at, reported_at, person_name, job_title, company, is_employee, description, where_occurred, body_part, injury_nature, object_substance, witnesses, root_cause, corrective_actions, osha_recordable, osha_classification, injury_or_illness, days_away, days_restricted, privacy_case, case_number, wc_claim_ref, status';

/**
 * mayViewPrivate(companyId): whether the caller manages safety at that company (projects.team:edit —
 * there is no separate safety capability); privacy cases are redacted for everyone else (L5).
 */
export async function loadSafety(db: SupabaseClient, jobIds: ReadonlyArray<string>, mayViewPrivate: (companyId: string | null) => boolean = () => false): Promise<{ talks: ToolboxTalk[]; jhas: Jha[]; incidents: Incident[]; incidentsVisible: boolean }> {
  if (!jobIds.length) return { talks: [], jhas: [], incidents: [], incidentsVisible: true };
  const j = ids(jobIds);
  const [talks, att, jhas, inc] = await Promise.all([
    pm(db).from('cm_toolbox_talks').select('id, job_id, held_on, topic, language, presenter_name, notes').in('job_id', j).order('held_on', { ascending: false }).limit(500),
    pm(db).from('cm_toolbox_attendance').select('talk_id').in('job_id', j).limit(10000),
    pm(db).from('cm_jhas').select('id, job_id, work_date, task_description, area, steps, ppe, permits, status, signoffs').in('job_id', j).order('work_date', { ascending: false }).limit(500),
    pm(db).from('v_cm_incidents_masked').select(INCIDENT_COLS).in('job_id', j).order('occurred_at', { ascending: false }).limit(500),
  ]);
  const n = new Map<string, number>();
  for (const a of soft<{ talk_id: string }>(att)) n.set(a.talk_id, (n.get(a.talk_id) ?? 0) + 1);
  return {
    talks: list<Omit<ToolboxTalk, 'attendees'>>(talks).map((t) => ({ ...t, attendees: n.get(t.id) ?? 0 })),
    jhas: list<Jha>(jhas),
    // pm.v_cm_incidents_masked nulls privacy-case detail at the database; redacted here again (defense in depth)
    incidents: soft<Incident & { location_id: string | null }>(inc).map((i) => redactPrivacyCase(i, mayViewPrivate(i.location_id))),
    incidentsVisible: !inc.error,
  };
}

// ------------------------------------------------------------------ productivity (CGC-89/90)

export async function loadProductivityJob(db: SupabaseClient, jobId: string, companyId: string): Promise<{ units: CostCodeUnit[]; codes: CostCodeLite[]; quantities: InstalledQty[]; alerts: FadeAlert[] }> {
  const [u, c, q, a] = await Promise.all([
    pm(db).from('cm_cost_code_units').select('id, job_id, cost_code_id, budget_qty, uom, budget_hours, unit_hours, pct_complete_entry').eq('job_id', jobId),
    pm(db).from('cost_codes').select('id, code, name').eq('location_id', companyId).or(`job_id.is.null,job_id.eq.${jobId}`).eq('is_active', true).order('code').limit(2000),
    pm(db).from('cm_installed_quantities').select('id, job_id, cost_code_id, work_date, qty, pct_complete, uom, area, note, created_at').eq('job_id', jobId).order('work_date', { ascending: false }).limit(300),
    pm(db).from('cm_fade_alerts').select('id, job_id, cost_code_id, week_start, budget_hours, earned_hours, actual_hours, week_earned_hours, week_actual_hours, productivity_factor, pct_hours_used, pct_complete, projected_hours, severity, cause_hint, status').eq('job_id', jobId).order('week_start', { ascending: false }).limit(200),
  ]);
  return { units: list<CostCodeUnit>(u), codes: soft<CostCodeLite>(c), quantities: list<InstalledQty>(q), alerts: soft<FadeAlert>(a) };
}

// ------------------------------------------------------------------ workforce (CGC-92)

export async function loadWorkforce(db: SupabaseClient, companyId: string, from: string): Promise<{ requests: CrewRequest[]; assignments: Assignment[]; conflicts: Array<{ week_start: string; employee_id: string | null; job_id: string | null; conflict: string; detail: string }>; employees: Array<{ id: string; name: string; title: string | null }> }> {
  const [req, asg, conf, emp] = await Promise.all([
    pm(db).from('cm_workforce_requests').select('id, job_id, trade, role, headcount, start_week, end_week, status').eq('location_id', companyId).gte('end_week', from).neq('status', 'CANCELLED').order('start_week'),
    pm(db).from('cm_workforce_assignments').select('id, job_id, employee_id, request_id, role, week_start, days, per_diem, travel, status').eq('location_id', companyId).gte('week_start', from).order('week_start').limit(5000),
    pm(db).from('cm_v_workforce_conflicts').select('week_start, employee_id, job_id, conflict, detail').eq('location_id', companyId).gte('week_start', from),
    db.schema('core').from('employees').select('id, first_name, last_name, title').eq('is_active', true).order('first_name').limit(1000),
  ]);
  return {
    requests: list<CrewRequest>(req),
    assignments: list<Assignment>(asg),
    conflicts: soft(conf),
    employees: soft<{ id: string; first_name: string | null; last_name: string | null; title: string | null }>(emp).map((e) => ({ id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member', title: e.title })),
  };
}

// ------------------------------------------------------------------ billing calendar (CGC-102)

export async function loadBillingCalendar(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<Array<CalendarRow & { location_id: string; customer_id?: string | null }>> {
  let q = pm(db).from('cm_v_billing_calendar').select('job_id, location_id, job_number, job_name, customer_name, billing_form, billing_portal_url, billing_cutoff_day, next_cutoff, pencil_due, current_status, current_stage, portal_status, retainage_outstanding_cents').order('next_cutoff');
  if (companyIds.length) q = q.in('location_id', [...companyIds]);
  return list(await q.limit(2000));
}

/** Billed and outstanding by job from the issued billing requests (Books' invoices, as Projects has them). */
export async function loadBilledByJob(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<Record<string, { billed: number; last: string | null }>> {
  if (!jobIds.length) return {};
  const r = soft<{ job_id: string; net_cents: number | null; occurred_on: string | null; status: string }>(await pm(db).from('billing_requests').select('job_id, net_cents, occurred_on, status').in('job_id', ids(jobIds)).in('status', ['ISSUED', 'UNISSUED', 'EMITTED']).limit(5000));
  const out: Record<string, { billed: number; last: string | null }> = {};
  for (const x of r) {
    const o = out[x.job_id] ?? { billed: 0, last: null };
    o.billed += Number(x.net_cents ?? 0);
    if (x.occurred_on && (!o.last || x.occurred_on > o.last)) o.last = x.occurred_on;
    out[x.job_id] = o;
  }
  return out;
}

// ------------------------------------------------------------------ closeout (CGC-103/106)

const CLOSE_COLS = 'id, job_id, category, title, form_ref, commitment_id, vendor_id, spec_section, required, status, due_on, document_id, warranty_starts_on, warranty_years, warranty_ends_on, accepted_at, notes';

export async function loadCloseout(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ items: CloseoutItem[]; vendors: Record<string, string> }> {
  if (!jobIds.length) return { items: [], vendors: {} };
  const items = list<CloseoutItem>(await pm(db).from('cm_closeout_items').select(CLOSE_COLS).in('job_id', ids(jobIds)).order('category').order('title').limit(5000));
  const vids = [...new Set(items.map((i) => i.vendor_id).filter((x): x is string => !!x))];
  const vendors = vids.length ? soft<{ id: string; name: string; display_name: string | null }>(await pm(db).from('v_core_vendors_masked').select('id, name, display_name').in('id', ids(vids))) : [];
  return { items, vendors: Object.fromEntries(vendors.map((v) => [v.id, v.display_name || v.name])) };
}

// ------------------------------------------------------------------ monthly review (CGC-111)

export async function loadReviewPackages(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<ReviewPackage[]> {
  if (!jobIds.length) return [];
  return list<ReviewPackage>(await pm(db).from('cm_review_packages').select('id, job_id, location_id, period_end, status, pm_commentary, built_at, submitted_at, signed_at, submitted_by, signed_by, content').in('job_id', ids(jobIds)).order('period_end', { ascending: false }).limit(600));
}
