/**
 * The app side of the migration-1111 build contract (SHARED-RECORDS §9). Every RPC argument
 * object and every table/view name the CRM, customer and tie-out screens use is built HERE, so
 * a rename in 1111 is a one-file change. Pure.
 *
 * §9 fixes the table, view and column names and the signatures of match_parties, merge_parties,
 * dismiss_duplicate, move_lead and convert_lead. For the functions §9 writes as "(...)"
 * (create_contact, create_site, create_lead, log_activity, complete_followup) the argument
 * names below follow the table columns with the house `p_` prefix (the 1108/1110 convention)
 * and were sent to the 1111 author to match.
 */

export const T = {
  contacts: { schema: 'core', table: 'contacts' },
  sites: { schema: 'core', table: 'sites' },
  duplicateReviews: { schema: 'core', table: 'duplicate_reviews' },
  relationship: { schema: 'core', table: 'v_customer_relationship' },
  pipelines: { schema: 'crm', table: 'pipelines' },
  stages: { schema: 'crm', table: 'pipeline_stages' },
  leads: { schema: 'crm', table: 'leads' },
  stageEvents: { schema: 'crm', table: 'lead_stage_events' },
  activities: { schema: 'crm', table: 'activities' },
  followups: { schema: 'crm', table: 'followups' },
  customer360: { schema: 'pm', table: 'v_customer_360' },
  jobTieout: { schema: 'pm', table: 'v_job_tieout' },
  companyTieout: { schema: 'pm', table: 'v_company_tieout' },
} as const;

export const LEAD_COLS =
  'id, org_id, location_id, pipeline_id, stage_id, title, customer_id, contact_id, site_id, source, source_detail, campaign, ' +
  'owner_membership_id, estimated_value_cents, expected_close_on, next_step, next_step_on, lost_reason, won_at, lost_at, ' +
  'converted_estimate_id, converted_job_id, created_by, created_at, updated_at';
export const STAGE_COLS = 'id, pipeline_id, key, name, kind, probability_pct, sort';
export const PIPELINE_COLS = 'id, org_id, location_id, key, name, pack_key, is_default';
export const CONTACT_COLS =
  'id, org_id, customer_id, vendor_id, first_name, last_name, email, phone, title, roles, is_primary, can_sign, can_pay, ' +
  'sms_consent, email_consent, consent_at, identity_status, created_at, updated_at';
export const SITE_COLS =
  'id, org_id, customer_id, location_id, name, address_line1, address_line2, city, state, zip, lat, lng, access_notes, ' +
  'tax_jurisdiction, identity_status, created_at, updated_at';
export const ACTIVITY_COLS = 'id, lead_id, customer_id, contact_id, job_id, kind, direction, subject, body, outcome, occurred_at, created_by, created_at';
export const FOLLOWUP_COLS = 'id, lead_id, due_on, kind, assigned_membership_id, done_at, cadence_key, created_at';
export const STAGE_EVENT_COLS = 'id, lead_id, from_stage_id, to_stage_id, reason, actor_id, created_at';
export const REVIEW_COLS = 'id, org_id, kind, a_id, b_id, suggested_survivor_id, score, matched, source, status, resolved_by, resolved_at, created_at';
export const TIEOUT_COLS = 'job_id, check_key, projects_cents, books_cents, diff_cents, status, cause, action';

// ------------------------------------------------------------------ argument builders

export interface ContactInput {
  customerId: string | null;
  vendorId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  roles: string[];
  isPrimary: boolean;
  canSign: boolean;
  canPay: boolean;
  smsConsent: boolean;
  emailConsent: boolean;
}

export function createContactArgs(c: ContactInput) {
  return {
    p_customer: c.customerId,
    p_vendor: c.vendorId,
    p_first_name: c.firstName,
    p_last_name: c.lastName,
    p_email: c.email ? c.email.toLowerCase() : null,
    p_phone: c.phone,
    p_title: c.title,
    p_roles: c.roles,
    p_is_primary: c.isPrimary,
    p_can_sign: c.canSign,
    p_can_pay: c.canPay,
    p_sms_consent: c.smsConsent,
    p_email_consent: c.emailConsent,
  };
}

export interface SiteInput {
  customerId: string;
  companyId: string | null;
  name: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  accessNotes: string | null;
  taxJurisdiction: string | null;
}

export function createSiteArgs(s: SiteInput) {
  return {
    p_customer: s.customerId,
    p_location: s.companyId,
    p_name: s.name,
    p_address_line1: s.line1,
    p_address_line2: s.line2,
    p_city: s.city,
    p_state: s.state,
    p_zip: s.zip,
    p_access_notes: s.accessNotes,
    p_tax_jurisdiction: s.taxJurisdiction,
  };
}

export interface LeadInput {
  companyId: string;
  title: string;
  pipelineId: string | null;
  stageId: string | null;
  customerId: string | null;
  contactId: string | null;
  siteId: string | null;
  source: string | null;
  sourceDetail: string | null;
  campaign: string | null;
  ownerMembershipId: string | null;
  valueCents: number | null;
  expectedCloseOn: string | null;
  nextStep: string | null;
  nextStepOn: string | null;
}

export function createLeadArgs(l: LeadInput) {
  return {
    p_location: l.companyId,
    p_title: l.title,
    p_pipeline: l.pipelineId,
    p_stage: l.stageId,
    p_customer: l.customerId,
    p_contact: l.contactId,
    p_site: l.siteId,
    p_source: l.source,
    p_source_detail: l.sourceDetail,
    p_campaign: l.campaign,
    p_owner: l.ownerMembershipId,
    p_estimated_value_cents: l.valueCents,
    p_expected_close_on: l.expectedCloseOn,
    p_next_step: l.nextStep,
    p_next_step_on: l.nextStepOn,
  };
}

export function moveLeadArgs(leadId: string, stageId: string, reason: string | null) {
  return { p_lead: leadId, p_stage: stageId, p_reason: reason };
}

export interface ActivityInput {
  kind: string;
  leadId: string | null;
  customerId: string | null;
  contactId: string | null;
  jobId: string | null;
  direction: string | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  occurredAt: string | null;
}

export function logActivityArgs(a: ActivityInput) {
  return {
    p_kind: a.kind,
    p_lead: a.leadId,
    p_customer: a.customerId,
    p_contact: a.contactId,
    p_job: a.jobId,
    p_direction: a.direction,
    p_subject: a.subject,
    p_body: a.body,
    p_outcome: a.outcome,
    p_occurred_at: a.occurredAt,
  };
}

export function completeFollowupArgs(followupId: string, outcome: string | null = null) {
  return { p_followup: followupId, p_outcome: outcome };
}

export function convertLeadArgs(leadId: string, target: 'estimate' | 'job', jobTypeKey: string | null) {
  return { p_lead: leadId, p_target: target, p_job_type_key: jobTypeKey };
}

export function mergeArgs(kind: 'customer' | 'vendor' | 'contact', survivor: string, victim: string, choices: Readonly<Record<string, 'a' | 'b' | 'survivor' | 'victim'>>) {
  return { p_kind: kind, p_survivor: survivor, p_victim: victim, p_field_choices: choices };
}

export function dismissArgs(reviewId: string) {
  return { p_review: reviewId };
}

/** crm.convert_lead → {lead_id, target, customer_id, customer_created, job_id, estimate_id}. */
export function parseConvertResult(v: unknown): { estimateId: string | null; jobId: string | null; customerId: string | null; customerCreated: boolean } {
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const id = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return { estimateId: id('estimate_id'), jobId: id('job_id'), customerId: id('customer_id'), customerCreated: o.customer_created === true };
}

/** PostgREST "function/relation not found": the 1111 contract is not live in this database yet. */
export function isMissingContract(e: { code?: string | null } | null | undefined): boolean {
  const c = (e?.code ?? '').toUpperCase();
  return c === 'PGRST202' || c === 'PGRST205' || c === 'PGRST106' || c === '42883' || c === '42P01' || c === '3F000';
}
