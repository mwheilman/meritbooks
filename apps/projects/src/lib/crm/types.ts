/**
 * Row shapes of the crm schema and the shared core.contacts / core.sites tables (migration 1111,
 * SHARED-RECORDS §9). Pure.
 */

export type StageKind = 'open' | 'won' | 'lost';

export interface PipelineRow {
  id: string;
  org_id: string;
  location_id: string;
  key: string;
  name: string;
  pack_key: string | null;
  is_default: boolean;
}

export interface StageRow {
  id: string;
  pipeline_id: string;
  key: string;
  name: string;
  kind: StageKind;
  probability_pct: number | null;
  sort: number;
}

export interface Pipeline extends PipelineRow {
  stages: StageRow[];
}

export interface LeadRow {
  id: string;
  org_id: string;
  location_id: string;
  pipeline_id: string;
  stage_id: string;
  title: string;
  customer_id: string | null;
  contact_id: string | null;
  site_id: string | null;
  source: string | null;
  source_detail: string | null;
  campaign: string | null;
  owner_membership_id: string | null;
  estimated_value_cents: number | null;
  expected_close_on: string | null;
  next_step: string | null;
  next_step_on: string | null;
  lost_reason: string | null;
  won_at: string | null;
  lost_at: string | null;
  converted_estimate_id: string | null;
  converted_job_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const ACTIVITY_KINDS = ['call', 'sms', 'email', 'meeting', 'site_visit', 'note', 'portal_message', 'signed_document'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_WORDS: Readonly<Record<ActivityKind, string>> = {
  call: 'Call', sms: 'Text', email: 'Email', meeting: 'Meeting', site_visit: 'Site visit', note: 'Note',
  portal_message: 'Portal message', signed_document: 'Signed document',
};

export const DIRECTIONS = ['outbound', 'inbound'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface ActivityRow {
  id: string;
  lead_id: string | null;
  customer_id: string | null;
  contact_id: string | null;
  job_id: string | null;
  kind: ActivityKind;
  direction: Direction | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  occurred_at: string;
  created_by: string | null;
  created_at: string;
}

export interface FollowupRow {
  id: string;
  lead_id: string;
  due_on: string;
  kind: string;
  assigned_membership_id: string | null;
  done_at: string | null;
  cadence_key: string | null;
  created_at: string;
}

export interface StageEventRow {
  id: string;
  lead_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
}

export interface ContactRow {
  id: string;
  org_id: string;
  customer_id: string | null;
  vendor_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  roles: string[] | null;
  is_primary: boolean;
  can_sign: boolean;
  can_pay: boolean;
  sms_consent: boolean;
  email_consent: boolean;
  consent_at: string | null;
  identity_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface SiteRow {
  id: string;
  org_id: string;
  customer_id: string;
  location_id: string | null;
  name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  access_notes: string | null;
  tax_jurisdiction: string | null;
  identity_status: string | null;
  created_at: string;
  updated_at: string;
}

export type RelationshipStage = 'prospect' | 'customer' | 'former';

export const RELATIONSHIP_WORDS: Readonly<Record<RelationshipStage, string>> = {
  prospect: 'Prospect', customer: 'Customer', former: 'Former customer',
};

export interface DuplicateReviewRow {
  id: string;
  org_id: string;
  kind: 'customer' | 'vendor' | 'contact';
  a_id: string;
  b_id: string;
  score: number;
  matched: string[] | null;
  source: string | null;
  suggested_survivor_id: string | null;
  status: 'open' | 'merged' | 'not_duplicate';
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

/** Contact roles (BP-63). */
export const CONTACT_ROLES = [
  'owner', 'spouse', 'tenant', 'property_manager', 'architect', 'designer', 'ap_contact', 'site_super', 'lender_rep', 'other',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];
export const CONTACT_ROLE_WORDS: Readonly<Record<ContactRole, string>> = {
  owner: 'Owner', spouse: 'Spouse or partner', tenant: 'Tenant', property_manager: 'Property manager', architect: 'Architect',
  designer: 'Designer', ap_contact: 'Accounts payable', site_super: 'Site super', lender_rep: 'Lender rep', other: 'Other',
};

/** Lead sources seeded per pack (panel 06 §2d). */
export const LEAD_SOURCES = [
  { key: 'web_form', label: 'Web form' },
  { key: 'phone', label: 'Phone call' },
  { key: 'email', label: 'Email' },
  { key: 'google_lsa', label: 'Google Local Services' },
  { key: 'angi', label: 'Angi / HomeAdvisor' },
  { key: 'thumbtack', label: 'Thumbtack' },
  { key: 'houzz', label: 'Houzz' },
  { key: 'facebook', label: 'Facebook / Instagram' },
  { key: 'referral', label: 'Referral' },
  { key: 'repeat', label: 'Repeat customer' },
  { key: 'walk_in', label: 'Showroom walk-in' },
  { key: 'event', label: 'Home show or event' },
  { key: 'yard_sign', label: 'Yard sign or truck wrap' },
  { key: 'tech_set', label: 'Tech-set lead' },
  { key: 'agreement_renewal', label: 'Agreement renewal' },
  { key: 'oem', label: 'OEM lead' },
  { key: 'builder_rfq', label: 'Builder RFQ' },
  { key: 'itb', label: 'Invitation to bid' },
  { key: 'lender_referral', label: 'Lender or broker referral' },
  { key: 'other', label: 'Other' },
] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number]['key'];

export function sourceLabel(key: string | null | undefined): string {
  if (!key) return 'No source';
  return LEAD_SOURCES.find((s) => s.key === key)?.label ?? key.replace(/_/g, ' ');
}

/** Common lost reasons (BP-51); a typed one is always allowed. */
export const LOST_REASONS = ['Price', 'Went with a competitor', 'Timing', 'No response', 'Not a fit', 'Financing', 'Project cancelled'] as const;

export function contactName(c: Pick<ContactRow, 'first_name' | 'last_name' | 'email' | 'phone'>): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unnamed contact';
}

export function siteAddress(s: Pick<SiteRow, 'address_line1' | 'address_line2' | 'city' | 'state' | 'zip'>): string {
  const cityLine = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [s.address_line1, s.address_line2, cityLine].filter(Boolean).join(', ');
}
