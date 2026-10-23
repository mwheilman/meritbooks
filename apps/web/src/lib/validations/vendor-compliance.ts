/**
 * Zod schemas for the vendor W-9 / COI closed loop (migration 180,
 * FPB-vendor-compliance-chase §19). Literals mirror the migration CHECKs. Money is
 * integer cents; dates are YYYY-MM-DD.
 */
import { z } from 'zod';
import { COVERAGE_TYPES, TAX_1099_SCOPES, VENDOR_TYPES } from '@/lib/vendor-compliance/requirements';
import { PHONE_SOURCES } from '@/lib/vendor-compliance/bank-change';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cents = z.number().int().min(0).max(100_000_000_000).nullable();
const workType = z.string().regex(/^[a-z0-9_]{1,40}$/, 'Lower-case letters, digits and underscores').nullable();

export const W9_FORM_ENTITY_TYPES = ['INDIVIDUAL_SOLE_PROP', 'C_CORP', 'S_CORP', 'PARTNERSHIP', 'TRUST_ESTATE', 'LLC', 'OTHER'] as const;

export const dashboardQuery = z.object({ location_id: uuid.optional() });

export const vendorDetailQuery = z.object({ id: uuid });

export const reviewQueueQuery = z.object({ status: z.enum(['open', 'decided']).optional() });

export const reviewedCoverage = z.object({
  coverage_type: z.enum(COVERAGE_TYPES),
  carrier: z.string().max(200).nullable().optional(),
  policy_number: z.string().max(100).nullable().optional(),
  each_occurrence_cents: cents,
  aggregate_cents: cents,
  effective_date: isoDate.nullable(),
  expiration_date: isoDate.nullable(),
});

export const reviewAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept'),
    id: uuid,
    note: z.string().max(1000).nullable().optional(),
    coverages: z.array(reviewedCoverage).max(12).optional(),
    certificate_holder: z.string().max(300).nullable().optional(),
    additional_insured: z.boolean().nullable().optional(),
    waiver_of_subrogation: z.boolean().nullable().optional(),
    carrier: z.string().max(200).nullable().optional(),
    policy_number: z.string().max(100).nullable().optional(),
    apply_1099_signal: z.boolean().optional(),
  }),
  z.object({ action: z.literal('reject'), id: uuid, reason: z.string().trim().min(3).max(1000) }),
]);
export type ReviewAction = z.infer<typeof reviewAction>;

export const documentQuery = z.object({ submission_id: uuid });

export const requirementBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    id: uuid.nullable().optional(),
    name: z.string().trim().min(1).max(120),
    location_id: uuid.nullable(),
    vendor_type: z.enum(VENDOR_TYPES).nullable(),
    tax_1099: z.enum(TAX_1099_SCOPES),
    work_type: workType,
    w9_required: z.boolean(),
    coi_required: z.boolean(),
    min_gl_each_occurrence_cents: cents,
    min_gl_aggregate_cents: cents,
    min_auto_cents: cents,
    wc_required: z.boolean(),
    min_wc_each_accident_cents: cents,
    min_umbrella_cents: cents,
    require_additional_insured: z.boolean(),
    require_waiver_of_subrogation: z.boolean(),
    certificate_holder_name: z.string().trim().max(200).nullable(),
    expiry_lead_days: z.number().int().min(0).max(180),
    block_payment: z.boolean(),
    grace_days: z.number().int().min(0).max(90),
  }),
  z.object({ action: z.literal('retire'), id: uuid }),
]);
export type RequirementBody = z.infer<typeof requirementBody>;

export const profileBody = z.object({ vendor_id: uuid, vendor_type: z.enum(VENDOR_TYPES).nullable(), work_type: workType });

export const bankChangeBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('verify'),
    id: uuid,
    phone_used: z.string().trim().min(7).max(40),
    phone_source: z.enum(PHONE_SOURCES),
    contact_name: z.string().trim().min(2).max(120),
    called_at: z.string().datetime({ offset: true }).optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({ action: z.literal('reject'), id: uuid, reason: z.string().trim().min(3).max(500) }),
  z.object({
    action: z.literal('open'),
    vendor_id: uuid,
    new_bank_name: z.string().max(120).nullable().optional(),
    new_account_last4: z.string().regex(/^\d{4}$/).nullable().optional(),
    request_phone: z.string().max(40).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  }),
]);

export const chaseQuery = z.object({ location_id: uuid.optional() });

export const chaseBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('switch'), location_id: uuid.nullable(), key: z.enum(['w9', 'coi', 'coi_renewal']), on: z.boolean() }),
  z.object({ action: z.literal('request_now'), vendor_id: uuid, kind: z.enum(['w9', 'coi']) }),
]);

/** The fill-here W-9 (public portal). The TIN never leaves the server route. */
export const w9FormBody = z
  .object({
    legal_name: z.string().trim().min(2).max(200),
    business_name: z.string().trim().max(200).optional().default(''),
    entity_type: z.enum(W9_FORM_ENTITY_TYPES),
    llc_tax_class: z.enum(['C', 'S', 'P']).nullable().optional(),
    exempt_payee_code: z.string().trim().max(4).optional().default(''),
    address_line1: z.string().trim().min(3).max(200),
    address_line2: z.string().trim().max(200).optional().default(''),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Two-letter state'),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'ZIP code like 50309 or 50309-1234'),
    tin_type: z.enum(['SSN', 'EIN']),
    tin: z.string().max(20),
    tin_confirm: z.string().max(20),
    signer_name: z.string().trim().min(2).max(120),
    signature: z.string().trim().min(2).max(120),
    certify: z.literal(true),
    esign_consent: z.literal(true),
  })
  .superRefine((v, ctx) => {
    if (v.entity_type === 'LLC' && !v.llc_tax_class) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['llc_tax_class'], message: 'Pick how the LLC is taxed.' });
    if (v.signature.trim().toLowerCase() !== v.signer_name.trim().toLowerCase()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['signature'], message: 'Type your name exactly as above to sign.' });
  });
export type W9FormBody = z.infer<typeof w9FormBody>;
