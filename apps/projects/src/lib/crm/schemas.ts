/**
 * Request bodies for the lead, contact and site doors. Pure (the forms validate with the same
 * schemas the routes parse with).
 */
import { z } from 'zod';
import { MatchDecisionBody } from '@/lib/parties/match';
import { ACTIVITY_KINDS, CONTACT_ROLES, DIRECTIONS } from './types';

const opt = (max: number) => z.string().trim().max(max).nullish().transform((s) => (s ? s : null));
const optEmail = opt(254).refine((s) => s == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), 'Enter an email like name@company.com');
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-03').nullish().transform((s) => s ?? null);
const optUuid = z.string().uuid().nullish().transform((s) => s ?? null);
const cents = z.coerce.number().int().min(0).max(100_000_000_000).nullish().transform((n) => n ?? null);

/** The person on a new lead: an existing customer, or a new one (matched at the door). */
export const LeadCustomer = z.object({
  name: opt(200),
  email: optEmail,
  phone: opt(40),
  firstName: opt(100),
  lastName: opt(100),
  match: MatchDecisionBody,
});
export type LeadCustomerInput = z.infer<typeof LeadCustomer>;

export const LeadSite = z.object({
  line1: opt(200),
  line2: opt(200),
  city: opt(100),
  state: opt(40),
  zip: opt(20),
  accessNotes: opt(1000),
});

export const NewLeadBody = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1, 'Say what the work is').max(200, 'Up to 200 characters'),
  pipelineId: optUuid,
  stageId: optUuid,
  customer: LeadCustomer.nullish().transform((c) => c ?? null),
  site: LeadSite.nullish().transform((s) => s ?? null),
  source: opt(40),
  sourceDetail: opt(200),
  campaign: opt(100),
  ownerMembershipId: optUuid,
  valueCents: cents,
  expectedCloseOn: optDate,
  nextStep: opt(300),
  nextStepOn: optDate,
  notes: opt(4000),
});
export type NewLead = z.infer<typeof NewLeadBody>;

/** A new lead needs someone to call: a name, an email or a phone. */
export function leadHasPerson(c: LeadCustomerInput | null): boolean {
  if (!c) return false;
  return !!(c.match.useId || c.name || c.email || c.phone || c.firstName || c.lastName);
}

/** The customer name a new lead's person becomes (a household is named for the person). */
export function leadCustomerName(c: LeadCustomerInput): string | null {
  return c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || null);
}

export const UpdateLeadBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  source: opt(40).optional(),
  sourceDetail: opt(200).optional(),
  campaign: opt(100).optional(),
  ownerMembershipId: optUuid.optional(),
  valueCents: cents.optional(),
  expectedCloseOn: optDate.optional(),
  nextStep: opt(300).optional(),
  nextStepOn: optDate.optional(),
});
export type UpdateLead = z.infer<typeof UpdateLeadBody>;

/** UpdateLead → crm.leads columns (only the keys sent). */
export function leadPatch(u: UpdateLead): Record<string, string | number | null> {
  const map: Array<[keyof UpdateLead, string]> = [
    ['title', 'title'], ['source', 'source'], ['sourceDetail', 'source_detail'], ['campaign', 'campaign'],
    ['ownerMembershipId', 'owner_membership_id'], ['valueCents', 'estimated_value_cents'], ['expectedCloseOn', 'expected_close_on'],
    ['nextStep', 'next_step'], ['nextStepOn', 'next_step_on'],
  ];
  const out: Record<string, string | number | null> = {};
  for (const [k, col] of map) if (u[k] !== undefined) out[col] = u[k] as string | number | null;
  return out;
}

export const MoveLeadBody = z.object({
  stageId: z.string().uuid(),
  reason: opt(500),
});

export const ActivityBody = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  direction: z.enum(DIRECTIONS).nullish().transform((d) => d ?? null),
  subject: opt(200),
  body: opt(4000),
  outcome: opt(300),
  occurredAt: z.string().datetime({ offset: true }).nullish().transform((s) => s ?? null),
  /** Set the lead's next step in the same save (each activity has an outcome and a next step). */
  nextStep: opt(300),
  nextStepOn: optDate,
});
export type ActivityInputBody = z.infer<typeof ActivityBody>;

export const FollowupBody = z.object({
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  kind: z.enum(ACTIVITY_KINDS).default('call'),
  assignedMembershipId: optUuid,
});

export const ConvertBody = z.object({
  op: z.enum(['estimate', 'job']),
  jobTypeKey: opt(80),
});

export const ContactBody = z.object({
  firstName: opt(100),
  lastName: opt(100),
  email: optEmail,
  phone: opt(40),
  title: opt(100),
  roles: z.array(z.enum(CONTACT_ROLES)).max(10).default([]),
  isPrimary: z.boolean().default(false),
  canSign: z.boolean().default(false),
  canPay: z.boolean().default(false),
  smsConsent: z.boolean().default(false),
  emailConsent: z.boolean().default(false),
}).refine((c) => !!(c.firstName || c.lastName || c.email || c.phone), { message: 'Give the contact a name, an email or a phone', path: ['firstName'] });
export type ContactInputBody = z.infer<typeof ContactBody>;

export const NewContactBody = z.object({ contact: ContactBody, match: MatchDecisionBody });

export const SiteBody = z.object({
  name: opt(120),
  line1: z.string().trim().min(1, 'Enter the street address').max(200),
  line2: opt(200),
  city: opt(100),
  state: opt(40),
  zip: opt(20),
  accessNotes: opt(1000),
  taxJurisdiction: opt(100),
  companyId: optUuid,
});
export type SiteInputBody = z.infer<typeof SiteBody>;

/** ContactBody → core.contacts columns (edit). */
export function contactPatch(c: ContactInputBody): Record<string, string | boolean | string[] | null> {
  return {
    first_name: c.firstName, last_name: c.lastName, email: c.email ? c.email.toLowerCase() : null, phone: c.phone, title: c.title,
    roles: c.roles, is_primary: c.isPrimary, can_sign: c.canSign, can_pay: c.canPay, sms_consent: c.smsConsent, email_consent: c.emailConsent,
  };
}

/** SiteBody → core.sites columns (edit). */
export function sitePatch(s: SiteInputBody): Record<string, string | null> {
  return {
    name: s.name, address_line1: s.line1, address_line2: s.line2, city: s.city, state: s.state, zip: s.zip,
    access_notes: s.accessNotes, tax_jurisdiction: s.taxJurisdiction,
  };
}

export const MergeBody = z.object({
  op: z.literal('merge'),
  survivorId: z.string().uuid(),
  /** field → which record's value to keep */
  fields: z.record(z.string().max(60), z.enum(['survivor', 'victim'])).default({}),
});
export const DismissBody = z.object({ op: z.literal('dismiss') });
export const ReviewActionBody = z.discriminatedUnion('op', [MergeBody, DismissBody]);
