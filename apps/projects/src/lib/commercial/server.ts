import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, type PgErrorLike } from '@/lib/api-errors';
import type { MoneySubject } from '@/lib/pm/money/errors';
import { mapCommercialError } from './errors';
import type {
  ChangeEventRow, CloseGate, CoiRow, ComplianceQueueRow, DailyLogRow, EacForecastRow, EacLineRow, ExposureRow, InboxRow, LienWaiverRow,
  LogEntryRow, MeetingAttendeeRow, MeetingItemRow, MeetingRow, PcoRow, RfiResponseRow, RfiRow, RfqRow, SubPayAppRow, SubmittalReviewRow,
  SubmittalRow, WipRow, AuditFinding,
} from './types';

/**
 * Server access for the commercial pages and routes: the RLS client only (never a service
 * role), money read through the masked views, every PG error mapped to one plain sentence.
 */

export class CommercialError extends HttpError {
  constructor(status: number, message: string, code: string) {
    super(status, message, code);
    this.name = 'CommercialError';
  }
}

export function cmError(err: PgErrorLike, subject: MoneySubject = 'record'): CommercialError {
  const m = mapCommercialError(err, subject);
  return new CommercialError(m.status, m.body.error, m.body.code);
}

/** Call a 1120 member RPC (pm schema). */
export async function cmRpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, subject: MoneySubject = 'record'): Promise<T> {
  const res = await db.schema('pm').rpc(fn, args);
  if (res.error) throw cmError(res.error, subject);
  return res.data as T;
}

/** A table write's result (trigger tokens mapped). */
export function cmWrote<T>(res: { data: unknown; error: PgErrorLike | null }): T {
  if (res.error) throw cmError(res.error);
  return res.data as T;
}

function list<T>(res: { data: unknown; error: PgErrorLike | null }): T[] {
  if (res.error) throw cmError(res.error);
  return (res.data ?? []) as T[];
}

const ids = (xs: ReadonlyArray<string>) => [...new Set(xs)].slice(0, 400);

// ------------------------------------------------------------------ change chain

const CE_COLS = 'id, job_id, number, title, description, source_type, scope, reason_code, status, proceeding, directive_ref, proceeding_since, rom_revenue_cents, rom_cost_cents, schedule_days, pco_id, change_order_id, due_on, created_at';
const PCO_COLS = 'id, job_id, number, tier, parent_cor_id, title, status, cost_cents, markup_cents, amount_cents, schedule_days, change_order_id, submitted_at, due_on, decided_at';
const RFQ_COLS = 'id, job_id, change_event_id, number, vendor_id, commitment_id, status, due_on, sent_at, responded_at, total_cents';

export interface ChangeBoard {
  events: ChangeEventRow[];
  pcos: PcoRow[];
  rfqs: RfqRow[];
  exposure: ExposureRow[];
}

export async function loadChangeBoard(db: SupabaseClient, jobIds: ReadonlyArray<string>, opts: { contract: boolean; cost: boolean }): Promise<ChangeBoard> {
  if (!jobIds.length) return { events: [], pcos: [], rfqs: [], exposure: [] };
  const j = ids(jobIds);
  const pm = db.schema('pm');
  const [events, pcos, rfqs, exposure] = await Promise.all([
    pm.from('v_cm_change_events_masked').select(CE_COLS).in('job_id', j).neq('status', 'VOID').order('created_at', { ascending: false }).limit(500),
    // PCOs are contract-side records and RFQ pricing is cost: without the capability RLS returns none, so skip the call
    opts.contract ? pm.from('v_cm_pcos_masked').select(PCO_COLS).in('job_id', j).neq('status', 'VOID').order('created_at', { ascending: false }).limit(300) : Promise.resolve({ data: [], error: null }),
    opts.cost ? pm.from('cm_rfqs').select(RFQ_COLS).in('job_id', j).order('created_at', { ascending: false }).limit(300) : Promise.resolve({ data: [], error: null }),
    pm.from('cm_v_change_exposure').select('*').in('job_id', j),
  ]);
  return {
    events: list<ChangeEventRow>(events),
    pcos: list<PcoRow>(pcos),
    rfqs: list<RfqRow>(rfqs),
    exposure: list<ExposureRow>(exposure),
  };
}

export async function loadRfqs(db: SupabaseClient, changeEventId: string): Promise<RfqRow[]> {
  return list<RfqRow>(await db.schema('pm').from('cm_rfqs').select(RFQ_COLS).eq('change_event_id', changeEventId).order('created_at'));
}

// ------------------------------------------------------------------ RFIs

const RFI_COLS = 'id, job_id, number, subject, question, suggested_answer, discipline, spec_section, drawing_ref, location_text, priority, status, is_private, ball_in_court_kind, ball_in_court_name, ball_in_court_email, due_on, opened_at, answered_at, closed_at, official_response, responded_by_name, cost_impact, schedule_impact, impact_days, change_event_id, created_at';

export async function loadRfis(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<RfiRow[]> {
  if (!jobIds.length) return [];
  return list<RfiRow>(await db.schema('pm').from('cm_rfis').select(RFI_COLS).in('job_id', ids(jobIds)).neq('status', 'VOID').order('created_at', { ascending: false }).limit(500));
}

export async function loadRfi(db: SupabaseClient, rfiId: string): Promise<{ rfi: RfiRow | null; responses: RfiResponseRow[] }> {
  const pm = db.schema('pm');
  const [r, resp] = await Promise.all([
    pm.from('cm_rfis').select(RFI_COLS).eq('id', rfiId).maybeSingle(),
    pm.from('cm_rfi_responses').select('id, rfi_id, body, is_official, author_name, via, created_at').eq('rfi_id', rfiId).order('created_at'),
  ]);
  if (r.error) throw cmError(r.error);
  return { rfi: (r.data ?? null) as RfiRow | null, responses: list<RfiResponseRow>(resp) };
}

// ------------------------------------------------------------------ submittals

const SUB_COLS = 'id, job_id, number, revision, spec_section, title, submittal_type, package, status, responsible_vendor_id, ball_in_court_kind, ball_in_court_name, required_on_site, lead_time_days, review_days, submit_by, long_lead, submitted_at, returned_at, final_code, released_for_fab_on, procurement_status, generated';

export async function loadSubmittals(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<SubmittalRow[]> {
  if (!jobIds.length) return [];
  return list<SubmittalRow>(await db.schema('pm').from('cm_submittals').select(SUB_COLS).in('job_id', ids(jobIds)).neq('status', 'VOID').order('spec_section').order('number').limit(1000));
}

export async function loadSubmittalReviews(db: SupabaseClient, submittalId: string): Promise<SubmittalReviewRow[]> {
  return list<SubmittalReviewRow>(await db.schema('pm').from('cm_submittal_reviews')
    .select('id, submittal_id, revision, step, reviewer_kind, reviewer_name, status, due_on, response_code, comments, returned_at').eq('submittal_id', submittalId).order('revision').order('step'));
}

// ------------------------------------------------------------------ meetings

export async function loadMeetings(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<{ meetings: MeetingRow[]; items: MeetingItemRow[] }> {
  if (!jobIds.length) return { meetings: [], items: [] };
  const pm = db.schema('pm');
  const j = ids(jobIds);
  const [m, i] = await Promise.all([
    pm.from('cm_meetings').select('id, job_id, meeting_type, series_key, number, title, scheduled_at, location_text, status, agenda, minutes, previous_meeting_id, distributed_at')
      .in('job_id', j).neq('status', 'CANCELLED').order('scheduled_at', { ascending: false, nullsFirst: false }).limit(300),
    pm.from('cm_meeting_items').select('id, job_id, origin_meeting_id, series_key, item_no, topic, description, owner_name, owner_company, due_on, status, closed_at')
      .in('job_id', j).order('item_no').limit(1000),
  ]);
  return { meetings: list<MeetingRow>(m), items: list<MeetingItemRow>(i) };
}

export async function loadAttendees(db: SupabaseClient, meetingId: string): Promise<MeetingAttendeeRow[]> {
  return list<MeetingAttendeeRow>(await db.schema('pm').from('cm_meeting_attendees').select('id, meeting_id, name, company, email, role, attended, accepted_minutes_at').eq('meeting_id', meetingId).order('name'));
}

// ------------------------------------------------------------------ daily log

const LOG_COLS = 'id, job_id, field_log_id, log_date, status, weather_summary, temp_high_f, temp_low_f, precipitation, wind, site_conditions, work_performed, safety_notes, signed_by_name, signed_at, amended_count, copied_from';
const ENTRY_COLS = 'id, daily_log_id, kind, vendor_id, company_name, trade, headcount, hours, equipment, equipment_hours, supplier, description, cause, duration_hours, responsible_party, notice_sent, inspector, result, is_amendment, amendment_reason, created_at';

export async function loadDailyLog(db: SupabaseClient, logId: string): Promise<{ log: DailyLogRow | null; entries: LogEntryRow[] }> {
  const pm = db.schema('pm');
  const [l, e] = await Promise.all([
    pm.from('cm_daily_logs').select(LOG_COLS).eq('id', logId).maybeSingle(),
    pm.from('cm_log_entries').select(ENTRY_COLS).eq('daily_log_id', logId).order('sort').order('created_at'),
  ]);
  if (l.error) throw cmError(l.error);
  return { log: (l.data ?? null) as DailyLogRow | null, entries: list<LogEntryRow>(e) };
}

/** The commercial log behind a field log (pm.field_logs) when one exists. */
export async function dailyLogForFieldLog(db: SupabaseClient, fieldLogIds: ReadonlyArray<string>): Promise<Record<string, string>> {
  if (!fieldLogIds.length) return {};
  const rows = list<{ id: string; field_log_id: string }>(await db.schema('pm').from('cm_daily_logs').select('id, field_log_id').in('field_log_id', ids(fieldLogIds)));
  return Object.fromEntries(rows.map((r) => [r.field_log_id, r.id]));
}

// ------------------------------------------------------------------ WIP / EAC

export async function loadWip(db: SupabaseClient, locationId: string, periodEnd: string): Promise<WipRow[]> {
  return cmRpc<WipRow[]>(db, 'cm_wip_schedule', { p_location: locationId, p_period_end: periodEnd });
}

const EAC_COLS = 'id, job_id, period_end, version, status, due_on, prepared_by, submitted_at, approved_by, approved_at, rejected_reason, contract_cents, total_budget_cents, total_actual_cents, total_ctc_cents, total_eac_cents, prior_eac_cents, reason_code, commentary, loss_flag';

export async function loadForecasts(db: SupabaseClient, jobIds: ReadonlyArray<string>, periodEnd: string): Promise<EacForecastRow[]> {
  if (!jobIds.length) return [];
  return list<EacForecastRow>(await db.schema('pm').from('cm_eac_forecasts').select(EAC_COLS).in('job_id', ids(jobIds)).eq('period_end', periodEnd).neq('status', 'SUPERSEDED').order('version', { ascending: false }));
}

export async function loadForecast(db: SupabaseClient, forecastId: string): Promise<{ forecast: EacForecastRow | null; lines: EacLineRow[] }> {
  const pm = db.schema('pm');
  const [f, l] = await Promise.all([
    pm.from('cm_eac_forecasts').select(EAC_COLS).eq('id', forecastId).maybeSingle(),
    pm.from('cm_eac_lines').select('id, forecast_id, cost_code_id, cost_code, cost_code_name, cost_type, budget_cents, committed_cents, actual_cents, pending_cents, ctc_cents, eac_cents, prior_eac_cents, method, commentary, sort').eq('forecast_id', forecastId).order('sort'),
  ]);
  if (f.error) throw cmError(f.error);
  return { forecast: (f.data ?? null) as EacForecastRow | null, lines: list<EacLineRow>(l) };
}

// ------------------------------------------------------------------ compliance / subs

export async function loadComplianceQueue(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<ComplianceQueueRow[]> {
  if (!jobIds.length) return [];
  return list<ComplianceQueueRow>(await db.schema('pm').from('cm_v_compliance_queue').select('*').in('job_id', ids(jobIds)).order('payment_hold_effective', { ascending: false }).limit(500));
}

const SPA_COLS = 'id, job_id, commitment_id, vendor_id, application_no, period_end, status, submitted_via, submitted_at, scheduled_value_cents, gross_this_period_cents, work_to_date_cents, retainage_this_period_cents, net_due_cents, current_step, chain, rejected_reason';

export async function loadSubPayApps(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<SubPayAppRow[]> {
  if (!jobIds.length) return [];
  return list<SubPayAppRow>(await db.schema('pm').from('cm_sub_pay_apps').select(SPA_COLS).in('job_id', ids(jobIds)).neq('status', 'VOID').order('created_at', { ascending: false }).limit(300));
}

const WAIVER_COLS = 'id, job_id, commitment_id, vendor_id, sub_pay_app_id, direction, waiver_type, state_code, form_key, amount_cents, through_date, status, rejected_reason, requested_at, received_at, verified_at';

export async function loadWaivers(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<LienWaiverRow[]> {
  if (!jobIds.length) return [];
  return list<LienWaiverRow>(await db.schema('pm').from('v_cm_lien_waivers_masked').select(WAIVER_COLS).in('job_id', ids(jobIds)).neq('status', 'VOID').order('requested_at', { ascending: false }).limit(500));
}

export async function loadCois(db: SupabaseClient, vendorIds: ReadonlyArray<string>): Promise<CoiRow[]> {
  if (!vendorIds.length) return [];
  return list<CoiRow>(await db.schema('pm').from('cm_coi_certificates').select('id, vendor_id, job_id, commitment_id, carrier, earliest_expiry, status, verification, created_at')
    .in('vendor_id', ids(vendorIds)).neq('status', 'SUPERSEDED').order('created_at', { ascending: false }).limit(500));
}

// ------------------------------------------------------------------ audit, inbox, gate

export async function loadAudit(db: SupabaseClient, jobId: string): Promise<AuditFinding[]> {
  return cmRpc<AuditFinding[]>(db, 'cm_billing_audit', { p_job: jobId });
}

export async function loadAuditCompany(db: SupabaseClient, locationId: string): Promise<AuditFinding[]> {
  return cmRpc<AuditFinding[]>(db, 'cm_billing_audit_company', { p_location: locationId });
}

export async function loadInbox(db: SupabaseClient, locationId: string | null): Promise<InboxRow[]> {
  return cmRpc<InboxRow[]>(db, 'cm_ball_in_court', { p_location: locationId });
}

export async function loadCloseGate(db: SupabaseClient, jobId: string): Promise<CloseGate> {
  return cmRpc<CloseGate>(db, 'cm_job_close_gate', { p_job: jobId });
}
