/** Zod bodies for the Wave C commercial routes (app/api/commercial/**). Pure. */
import { z } from 'zod';
import { IsoDate, PosCents, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';

const Opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => v ?? null);
const Short = (max: number) => z.string().trim().max(max);
const Email = z.string().trim().email('Use an email address.').max(200);
const List = (max: number, len = 200) => z.array(z.string().trim().min(1).max(len)).max(max);

// ------------------------------------------------------------------ directory (CGC-04)
export const PARTY_ROLES = ['OWNER', 'OWNERS_REP', 'ARCHITECT', 'ENGINEER', 'CONSULTANT', 'GC', 'SUBCONTRACTOR', 'SUPPLIER', 'INSPECTOR', 'LENDER', 'SURETY', 'OTHER'] as const;
export const DirectoryEntryCreate = z.object({
  jobId: Uuid,
  partyRole: z.enum(PARTY_ROLES),
  vendorId: Opt(Uuid),
  customerId: Opt(Uuid),
  companyName: Opt(Text200),
  contactName: Opt(Text200),
  email: Opt(Email),
  phone: Opt(Short(40)),
  trade: Opt(Short(80)),
  csiDivisions: List(20, 4).default([]),
  distributionGroups: List(10, 40).default([]),
  isPrimary: z.boolean().default(false),
}).refine((b) => b.vendorId || b.customerId || b.companyName || b.contactName, { message: 'Name the company or the contact.', path: ['companyName'] });
export const DirectoryEntryUpdate = z.object({
  partyRole: z.enum(PARTY_ROLES).optional(),
  contactName: Opt(Text200).optional(),
  email: Opt(Email).optional(),
  phone: Opt(Short(40)).optional(),
  trade: Opt(Short(80)).optional(),
  csiDivisions: List(20, 4).optional(),
  distributionGroups: List(10, 40).optional(),
  isPrimary: z.boolean().optional(),
});

const License = z.object({ state: Short(2).optional(), number: Short(60).optional(), class: Short(60).optional(), expires: IsoDate.optional() });
export const ProfileUpsert = z.object({
  vendorId: Opt(Uuid),
  customerId: Opt(Uuid),
  companyId: Opt(Uuid),
  csiDivisions: List(30, 4).default([]),
  trades: List(10, 80).default([]),
  licenses: z.array(License).max(20).default([]),
  unionLocal: Opt(Short(80)),
  dbe: z.boolean().default(false),
  mbe: z.boolean().default(false),
  wbe: z.boolean().default(false),
  sdvob: z.boolean().default(false),
  emr: Opt(z.number().min(0).max(5)),
  emrYear: Opt(z.number().int().min(2000).max(2100)),
  bondingSingleCents: Opt(PosCents),
  bondingAggregateCents: Opt(PosCents),
  prequalStatus: z.enum(['NONE', 'PENDING', 'QUALIFIED', 'EXPIRED', 'DISQUALIFIED']).default('NONE'),
  prequalExpires: Opt(IsoDate),
  notes: Opt(Text2000),
}).refine((b) => !!b.vendorId !== !!b.customerId, { message: 'Pick the vendor or the customer.', path: ['vendorId'] });

// ------------------------------------------------------------------ project templates (CGC-06)
const Payload = z.object({
  contract_settings: z.object({
    change_tiers: z.number().int().min(1).max(3).optional(),
    billing_cutoff_day: z.number().int().min(1).max(31).optional(),
    billing_form: z.enum(['AIA', 'GC_FORM', 'OWNER_FORM', 'TEXTURA', 'GCPAY', 'PROCORE_PAY', 'OTHER']).optional(),
    retainage_step_mode: z.enum(['NEW_WORK_ONLY', 'REDUCE_TO_DATE']).optional(),
    stored_retainage_pct: z.number().min(0).max(1).optional(),
    architect_certification: z.boolean().optional(),
    rfi_default_days: z.number().int().min(1).max(90).optional(),
    submittal_review_days: z.number().int().min(1).max(90).optional(),
    bonded: z.boolean().optional(),
    prevailing_wage: z.boolean().optional(),
    px_threshold_cents: PosCents.optional(),
  }).partial().optional(),
  retainage_steps: z.array(z.object({ side: z.enum(['RECEIVABLE', 'PAYABLE']).optional(), from_pct: z.number().min(0).max(1), rate: z.number().min(0).max(1), note: Short(200).optional() })).max(10).optional(),
  markup_rules: z.array(z.object({
    kind: z.enum(['OHP', 'OVERHEAD', 'PROFIT', 'FEE', 'BOND', 'INSURANCE', 'LABOR_BURDEN', 'OTHER']), label: Short(80).optional(),
    applies_to: z.enum(['ALL', 'SELF_PERFORM', 'SUBCONTRACT']).optional(), cost_type: z.enum(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER']).nullish(),
    pct: z.number().min(0).max(1), compounding: z.boolean().optional(), sort: z.number().int().min(0).max(99).optional(),
  })).max(20).optional(),
  closeout: z.array(z.object({ category: z.string().trim().min(2).max(40), title: z.string().trim().min(1).max(200), form_ref: Short(60).optional(), required: z.boolean().optional() })).max(60).optional(),
}).passthrough();
export const TemplateUpdate = z.object({
  name: z.string().trim().min(1, 'Name the template.').max(120).optional(),
  description: Opt(Text2000).optional(),
  isActive: z.boolean().optional(),
  payload: Payload.optional(),
});
export const TemplateDuplicate = z.object({ op: z.literal('duplicate'), name: z.string().trim().min(1, 'Name the copy.').max(120), companyId: Uuid });

/** "Ground-up — Hospital" → "ground_up_hospital" (template keys are ^[a-z][a-z0-9_]{1,47}$). */
export function templateKey(name: string, suffix = ''): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '') || 'custom';
  return `${base}${suffix}`.slice(0, 48).replace(/_+$/, '') || 'custom';
}

// ------------------------------------------------------------------ trade proposals (CGC-25)
const ProposalBody = {
  customerId: Opt(Uuid),
  projectName: z.string().trim().min(1, 'Name the project.').max(200),
  baseBidCents: PosCents,
  alternates: z.array(z.object({ label: z.string().trim().min(1).max(200), amount_cents: z.number().int().min(-1e13).max(1e13) })).max(30).default([]),
  unitPrices: z.array(z.object({ item: z.string().trim().min(1).max(200), uom: z.string().trim().min(1).max(20), unit_cents: PosCents })).max(60).default([]),
  inclusions: List(80, 300).default([]),
  exclusions: List(80, 300).default([]),
  qualifications: List(80, 300).default([]),
  scheduleAssumptions: Opt(Text2000),
  validUntil: Opt(IsoDate),
};
export const ProposalCreate = z.object({ companyId: Uuid, ...ProposalBody });
export const ProposalUpdate = z.object(ProposalBody).partial();

/** The trade's standard exclusions (CGC-25), offered as a starting list. */
export const STANDARD_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  ELECTRICAL: ['Utility company charges and primary service', 'Low-voltage, fire alarm and security wiring unless listed', 'Trenching and backfill in rock', 'Patching and painting of walls', 'Permit fees beyond the electrical permit', 'Overtime and shift premium'],
  MECHANICAL: ['Controls wiring by others', 'Structural steel supports and roof curbs', 'Fire dampers in rated walls by others', 'Test and balance unless listed', 'Overtime and shift premium'],
  PLUMBING: ['Site utilities beyond 5 feet of the building', 'Fixtures furnished by the owner', 'Concrete cutting and patching', 'Overtime and shift premium'],
  GENERAL: ['Bonds unless listed', 'Builder’s risk insurance', 'Hazardous material abatement', 'Engineering and design', 'Work outside normal hours', 'Winter conditions and temporary heat'],
};

// ------------------------------------------------------------------ buyout (CGC-30)
export const BuyoutUpdate = z.object({
  status: z.enum(['OPEN', 'BIDDING', 'AWARDED', 'NOT_NEEDED']).optional(),
  needBy: Opt(IsoDate).optional(),
  leadTimeDays: z.number().int().min(0).max(730).optional(),
  budgetOverrideCents: Opt(PosCents).optional(),
  commitmentIds: z.array(Uuid).max(50).optional(),
  notes: Opt(Text2000).optional(),
});

// ------------------------------------------------------------------ pay app signature / export (CGC-43/44)
export const PayAppSign = z.object({
  signers: z.array(z.object({
    name: z.string().trim().min(1, 'Name the signer.').max(120),
    email: Opt(Email),
    roleLabel: Opt(Short(60)),
  })).min(1, 'Add who signs.').max(4),
  message: Opt(Text2000),
});
export const PayAppExportQuery = z.object({ format: z.enum(['AIA_G703', 'TEXTURA', 'GCPAY', 'PROCORE_PAY', 'GC_FORM']) });

// ------------------------------------------------------------------ specifications (CGC-62)
export const SpecImport = z.object({
  jobId: Uuid,
  addendum: Opt(Short(60)),
  sections: z.array(z.object({ number: z.string().trim().min(2).max(20), title: z.string().trim().min(1).max(200) })).min(1, 'Paste at least one section.').max(2000),
});
export const SpecUpdate = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  revision: z.number().int().min(0).max(99).optional(),
  addendum: Opt(Short(60)).optional(),
  pageStart: Opt(z.number().int().min(1).max(20000)).optional(),
  pageEnd: Opt(z.number().int().min(1).max(20000)).optional(),
});

// ------------------------------------------------------------------ correspondence (CGC-67)
export const DocControlStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('transmittal'), status: z.enum(['DRAFT', 'SENT', 'ACKNOWLEDGED', 'VOID']), acknowledgedBy: Opt(Text200) }),
  z.object({ kind: z.literal('letter'), status: z.enum(['DRAFT', 'SENT', 'RECEIVED', 'RESPONDED', 'CLOSED', 'VOID']), respondedOn: Opt(IsoDate) }),
]);

// ------------------------------------------------------------------ safety (CGC-78/79)
export const IncidentUpdate = z.object({
  rootCause: Opt(Text2000).optional(),
  correctiveActions: z.array(z.object({ action: z.string().trim().min(1).max(300), owner: Short(120).optional(), due: IsoDate.optional(), done: z.boolean().optional() })).max(30).optional(),
  witnesses: z.array(z.object({ name: z.string().trim().min(1).max(120), phone: Short(40).optional(), statement: Short(2000).optional() })).max(20).optional(),
  oshaRecordable: Opt(z.boolean()).optional(),
  oshaClassification: Opt(z.enum(['DEATH', 'DAYS_AWAY', 'RESTRICTED_OR_TRANSFER', 'OTHER_RECORDABLE'])).optional(),
  injuryOrIllness: Opt(z.enum(['INJURY', 'SKIN_DISORDER', 'RESPIRATORY', 'POISONING', 'HEARING_LOSS', 'OTHER_ILLNESS'])).optional(),
  daysAway: z.number().int().min(0).max(180).optional(),
  daysRestricted: z.number().int().min(0).max(180).optional(),
  privacyCase: z.boolean().optional(),
  wcClaimRef: Opt(Short(80)).optional(),
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'CLOSED']).optional(),
}).refine((b) => !(b.oshaRecordable === true && b.oshaClassification === null), { message: 'A recordable case needs its OSHA classification.', path: ['oshaClassification'] });
export const TalkSignIn = z.object({ name: z.string().trim().min(1, 'Who signed in?').max(120), company: Opt(Text200), method: z.enum(['SIGNATURE', 'QR', 'FACE', 'PAPER']).default('PAPER') });

// ------------------------------------------------------------------ productivity (CGC-89/90)
export const UnitsUpsert = z.object({
  jobId: Uuid,
  costCodeId: Uuid,
  budgetQty: Opt(z.number().min(0).max(1e9)),
  uom: Opt(Short(20)),
  budgetHours: z.number().min(0).max(1e8),
  pctCompleteEntry: z.boolean().default(false),
});
export const QuantityCreate = z.object({
  jobId: Uuid,
  costCodeId: Uuid,
  workDate: IsoDate,
  qty: Opt(z.number().min(0).max(1e8)),
  pctComplete: Opt(z.number().min(0).max(1)),
  uom: Opt(Short(20)),
  area: Opt(Text200),
  note: Opt(Text2000),
}).refine((b) => b.qty !== null || b.pctComplete !== null, { message: 'Enter the quantity installed or the percent complete.', path: ['qty'] });
export const FadeAlertAction = z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']) });

// ------------------------------------------------------------------ workforce (CGC-92)
export const AssignmentUpdate = z.object({ status: z.enum(['PLANNED', 'CONFIRMED', 'RELEASED']).optional(), days: z.number().int().min(0).max(7).optional(), perDiem: z.boolean().optional(), travel: z.boolean().optional() });
export const RequestUpdate = z.object({ status: z.enum(['OPEN', 'PARTIAL', 'FILLED', 'CANCELLED']) });

// ------------------------------------------------------------------ closeout (CGC-103)
export const CloseoutItemUpdate = z.object({
  status: z.enum(['REQUIRED', 'REQUESTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'WAIVED']).optional(),
  dueOn: Opt(IsoDate).optional(),
  warrantyStartsOn: Opt(IsoDate).optional(),
  warrantyYears: Opt(z.number().min(0).max(99)).optional(),
  notes: Opt(Text2000).optional(),
  required: z.boolean().optional(),
});
export const CloseoutItemCreate = z.object({
  jobId: Uuid,
  category: z.enum(['OM_MANUAL', 'WARRANTY', 'AS_BUILT', 'ATTIC_STOCK', 'TRAINING', 'FINAL_INSPECTION', 'CERTIFICATE_OF_OCCUPANCY', 'SUBSTANTIAL_COMPLETION', 'AFFIDAVIT_OF_PAYMENT',
    'RELEASE_OF_LIENS', 'CONSENT_OF_SURETY', 'FINAL_LIEN_WAIVER', 'PUNCH_COMPLETE', 'KEYS', 'COMMISSIONING', 'OTHER']),
  title: z.string().trim().min(1, 'Name the item.').max(200),
  vendorId: Opt(Uuid),
  specSection: Opt(Short(20)),
  dueOn: Opt(IsoDate),
});

/** camelCase body → the table's snake_case columns, leaving out keys that were not sent. */
export function toColumns(body: Record<string, unknown>, map: Readonly<Record<string, string>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(map)) if (Object.hasOwn(body, k) && body[k] !== undefined) out[col] = body[k];
  return out;
}
