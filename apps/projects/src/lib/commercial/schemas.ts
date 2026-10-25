/** Zod bodies for the commercial routes (app/api/commercial/**). Pure. */
import { z } from 'zod';
import { Cents, IsoDate, PosCents, Text200, Text2000, Uuid } from '@/lib/pm/money/schemas';

export const COMPLIANCE_REQUIREMENTS = ['GL_EACH_OCCURRENCE', 'GL_AGGREGATE', 'AUTO_COMBINED', 'UMBRELLA', 'WORKERS_COMP', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL', 'POLLUTION',
  'ADDITIONAL_INSURED_ONGOING', 'ADDITIONAL_INSURED_COMPLETED', 'WAIVER_OF_SUBROGATION', 'PRIMARY_NONCONTRIBUTORY', 'W9', 'LICENSE', 'PAYMENT_BOND', 'PERFORMANCE_BOND', 'EMR', 'CERTIFIED_PAYROLL'] as const;

const Opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => v ?? null);
const Note = Opt(Text2000);
const Fraction = z.number().min(0).max(1);

// ------------------------------------------------------------------ change events
export const ChangeEventCreate = z.object({
  jobId: Uuid,
  title: z.string().trim().min(1, 'Give the change a title.').max(200),
  description: Note,
  sourceType: z.enum(['RFI', 'ASI', 'BULLETIN', 'CCD', 'FIELD', 'OWNER_REQUEST', 'DESIGN', 'BACKCHARGE', 'TM', 'ALLOWANCE', 'DRAWING_REVISION', 'OTHER']).default('FIELD'),
  scope: z.enum(['IN', 'OUT', 'TBD']).default('TBD'),
  reasonCode: Opt(Text200),
  dueOn: Opt(IsoDate),
  scheduleDays: Opt(z.number().int().min(-999).max(999)),
  romRevenueCents: Opt(Cents),
  romCostCents: Opt(Cents),
});

export const ChangeEventAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), status: z.enum(['OPEN', 'PRICING', 'PRICED', 'NO_COST', 'VOID']), note: Note }),
  z.object({ op: z.literal('proceed'), proceeding: z.boolean(), directive: Opt(Text200), since: Opt(IsoDate) }),
  z.object({ op: z.literal('rfq'), vendorId: Uuid, commitmentId: Opt(Uuid), dueOn: Opt(IsoDate), scope: Note }),
  z.object({ op: z.literal('price'), romRevenueCents: Opt(Cents), romCostCents: Opt(Cents) }),
]);

export const PcoCreate = z.discriminatedUnion('op', [
  z.object({ op: z.literal('build'), jobId: Uuid, changeEventIds: z.array(Uuid).min(1, 'Pick at least one change.').max(50), title: Opt(Text200) }),
  z.object({ op: z.literal('roll'), pcoIds: z.array(Uuid).min(1).max(50), title: Opt(Text200) }),
]);

export const PcoAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('submit'), dueOn: Opt(IsoDate) }),
  z.object({ op: z.literal('revise'), note: Note }),
  z.object({ op: z.literal('reprice') }),
  z.object({ op: z.literal('propose_ccos') }),
]);

export const RfqAction = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('respond'),
    laborCents: Opt(PosCents), materialCents: Opt(PosCents), equipmentCents: Opt(PosCents), subcontractCents: Opt(PosCents), otherCents: Opt(PosCents),
    markupCents: Opt(PosCents), totalCents: Opt(PosCents), scheduleDays: Opt(z.number().int().min(-999).max(999)), exclusions: Note, responderName: Opt(Text200),
  }),
  z.object({ op: z.literal('decide'), accept: z.boolean() }),
]);

// ------------------------------------------------------------------ pay apps
const PayLine = z.object({
  sov_line_id: Uuid,
  pct_complete: Fraction.optional(),
  work_to_date_cents: PosCents.optional(),
  stored_materials_cents: PosCents.optional(),
});
export const PayAppCreate = z.discriminatedUnion('op', [
  z.object({ op: z.literal('draft'), jobId: Uuid, periodEnd: IsoDate, lines: z.array(PayLine).max(500).default([]), syncCos: z.boolean().default(true) }),
  z.object({ op: z.literal('sync_sov'), jobId: Uuid }),
]);
export const PayAppAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pencil'), to: Opt(Text200) }),
  z.object({ op: z.literal('return'), note: z.string().trim().min(1, 'Say what the owner wants changed.').max(2000) }),
  z.object({ op: z.literal('certify'), architect: z.string().trim().min(1, 'Name the architect who certified it.').max(200), certifiedCents: Cents, notarized: z.boolean().default(false) }),
  z.object({ op: z.literal('revise'), lines: z.array(PayLine).max(500).nullish(), reason: Note }),
  z.object({ op: z.literal('portal'), portal: z.enum(['TEXTURA', 'GCPAY', 'PROCORE_PAY', 'OWNER_PORTAL', 'EMAIL', 'OTHER']), status: z.enum(['NOT_SUBMITTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'PAID']) }),
]);

// ------------------------------------------------------------------ sub pay apps / waivers / compliance
const SubLine = z.object({
  commitment_line_id: Uuid,
  pct_complete: Fraction.optional(),
  work_to_date_cents: PosCents.optional(),
  stored_materials_cents: PosCents.optional(),
});
export const SubPayAppCreate = z.object({ commitmentId: Uuid, periodEnd: IsoDate, lines: z.array(SubLine).max(500).default([]) });
export const SubPayAppAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('submit') }),
  z.object({ op: z.literal('approve'), note: Note }),
  z.object({ op: z.literal('reject'), note: z.string().trim().min(1, 'Say why it is rejected.').max(2000) }),
  z.object({ op: z.literal('send_back'), note: z.string().trim().min(1, 'Say what the sub should fix.').max(2000) }),
  z.object({ op: z.literal('lines'), lines: z.array(SubLine).min(1).max(500) }),
  z.object({ op: z.literal('void'), reason: Note }),
]);

export const WaiverType = z.enum(['CONDITIONAL_PROGRESS', 'UNCONDITIONAL_PROGRESS', 'CONDITIONAL_FINAL', 'UNCONDITIONAL_FINAL']);
export const WaiverCreate = z.object({ commitmentId: Uuid, type: WaiverType, amountCents: Opt(PosCents), through: Opt(IsoDate), subPayAppId: Opt(Uuid), tier: z.number().int().min(1).max(4).default(1), claimant: Opt(Text200) });
export const WaiverAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sent'), envelopeId: Opt(Uuid) }),
  z.object({ op: z.literal('receive'), documentId: Opt(Uuid), amountCents: Opt(PosCents), throughDate: Opt(IsoDate), formKey: Opt(Text200) }),
  z.object({ op: z.literal('verify') }),
]);

export const SubcontractAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('record_payment'), amountCents: PosCents, paidOn: IsoDate, paymentRef: Opt(Text200), final: z.boolean().default(false) }),
  z.object({ op: z.literal('release_retainage'), amountCents: Opt(PosCents) }),
]);

const Policy = z.object({
  type: z.enum(['GL', 'AUTO', 'UMBRELLA', 'WC', 'EL', 'PROFESSIONAL', 'POLLUTION', 'BUILDERS_RISK']),
  policy_no: Opt(Text200),
  each_occurrence_cents: Opt(PosCents),
  aggregate_cents: Opt(PosCents),
  limit_cents: Opt(PosCents),
  expires: IsoDate,
});
export const ComplianceAction = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('record_coi'), vendorId: Uuid, companyId: Uuid, jobId: Opt(Uuid), commitmentId: Opt(Uuid), carrier: Opt(Text200), producer: Opt(Text200),
    certificateDate: Opt(IsoDate), policies: z.array(Policy).min(1, 'Add at least one policy.').max(12), endorsements: z.array(z.string().trim().min(2).max(40)).max(20).default([]),
    additionalInsured: z.boolean().default(false), waiverOfSubrogation: z.boolean().default(false), primaryNoncontributory: z.boolean().default(false),
    emr: Opt(z.number().min(0).max(5)), licenseNo: Opt(Text200), licenseExpires: Opt(IsoDate), documentId: Opt(Uuid),
  }),
  z.object({ op: z.literal('verify_coi'), coiId: Uuid }),
  z.object({ op: z.literal('chase'), companyId: Opt(Uuid) }),
  z.object({
    op: z.literal('requirement'), jobId: Opt(Uuid), companyId: Opt(Uuid),
    requirement: z.enum(COMPLIANCE_REQUIREMENTS),
    minLimitCents: Opt(PosCents), maxValue: Opt(z.number().min(0).max(10)), endorsementForms: z.array(z.string().trim().min(2).max(40)).max(10).default([]),
  }),
]);

// ------------------------------------------------------------------ T&M
const TmLine = z.object({
  kind: z.enum(['LABOR', 'MATERIAL', 'EQUIPMENT', 'SUBCONTRACT', 'OTHER']),
  labor_class: Opt(Text200), hours_st: z.number().min(0).max(24).default(0), hours_ot: z.number().min(0).max(24).default(0), hours_dt: z.number().min(0).max(24).default(0),
  qty: Opt(z.number().min(0).max(1e7)), uom: Opt(z.string().trim().max(20)), unit_cost_cents: Opt(PosCents), worker_name: Opt(Text200), equipment_hours: Opt(z.number().min(0).max(1000)),
  description: z.string().trim().max(2000).default(''),
});
export const TmCreate = z.object({ jobId: Uuid, workDate: IsoDate, description: z.string().trim().min(1, 'Describe the extra work.').max(4000), area: Opt(Text200), gcReference: Opt(Text200), changeEventId: Opt(Uuid), lines: z.array(TmLine).max(100).default([]) });
export const TmAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('submit') }),
  z.object({ op: z.literal('sign'), signerName: z.string().trim().min(1, 'Who signed?').max(120), signerTitle: Opt(Text200), signerCompany: Opt(Text200), signaturePng: Opt(z.string().max(400_000)), method: z.enum(['DEVICE', 'REMOTE', 'PAPER']).default('DEVICE') }),
  z.object({ op: z.literal('dispute'), reason: z.string().trim().min(1, 'Say what the GC disputes.').max(2000) }),
  z.object({ op: z.literal('pull_hours') }),
  z.object({ op: z.literal('to_change_event') }),
]);
export const TmBill = z.object({ jobId: Uuid, ticketIds: z.array(Uuid).min(1, 'Pick the signed tickets to bill.').max(200), occurredOn: Opt(IsoDate) });

// ------------------------------------------------------------------ EAC / WIP / review
export const EacCreate = z.object({ jobId: Uuid, periodEnd: IsoDate });
export const EacAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('line'), lineId: Uuid, ctcCents: Cents, commentary: Note }),
  z.object({ op: z.literal('submit'), reasonCode: Opt(Text200), commentary: Note, uninstalledCents: Opt(PosCents), inefficiencyCents: Opt(PosCents) }),
  z.object({ op: z.literal('decide'), approve: z.boolean(), note: Note }),
]);
export const WipQuery = z.object({ companyId: Uuid, periodEnd: IsoDate });
export const WipPin = z.object({ companyId: Uuid, periodEnd: IsoDate });
export const ReviewAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('build'), jobId: Uuid, periodEnd: IsoDate, commentary: Note }),
  z.object({ op: z.literal('submit'), packageId: Uuid, commentary: Note }),
  z.object({ op: z.literal('sign'), packageId: Uuid }),
]);

// ------------------------------------------------------------------ RFIs / submittals / meetings
export const RfiCreate = z.object({
  jobId: Uuid,
  subject: z.string().trim().min(1, 'Give the RFI a subject.').max(200),
  question: z.string().trim().min(1, 'Ask the question.').max(8000),
  suggestedAnswer: Note,
  discipline: Opt(Text200),
  specSection: Opt(z.string().trim().max(20)),
  drawingRef: Opt(Text200),
  locationText: Opt(Text200),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  isPrivate: z.boolean().default(false),
  costImpact: z.enum(['YES', 'NO', 'TBD']).default('TBD'),
  scheduleImpact: z.enum(['YES', 'NO', 'TBD']).default('TBD'),
  ballKind: z.enum(['INTERNAL', 'ARCHITECT', 'ENGINEER', 'OWNER', 'SUB', 'OTHER']).default('ARCHITECT'),
  ballName: Opt(Text200),
  ballEmail: Opt(z.string().trim().email('Use an email address.').max(200)),
  dueOn: Opt(IsoDate),
  open: z.boolean().default(true),
});
export const RfiAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), dueOn: Opt(IsoDate) }),
  z.object({ op: z.literal('ball'), kind: z.enum(['INTERNAL', 'ARCHITECT', 'ENGINEER', 'OWNER', 'SUB', 'OTHER']), membershipId: Opt(Uuid), name: Opt(Text200), email: Opt(z.string().trim().email().max(200)), dueOn: Opt(IsoDate) }),
  z.object({ op: z.literal('respond'), body: z.string().trim().min(1, 'Write the response.').max(8000), official: z.boolean().default(false), authorName: Opt(Text200) }),
  z.object({ op: z.literal('close') }),
  z.object({ op: z.literal('reopen') }),
  z.object({ op: z.literal('to_change_event') }),
]);

export const SubmittalCreate = z.discriminatedUnion('op', [
  z.object({ op: z.literal('generate'), jobId: Uuid }),
  z.object({ op: z.literal('import_specs'), jobId: Uuid, sections: z.array(z.object({ section: z.string().trim().min(2).max(20), title: z.string().trim().min(1).max(200) })).min(1).max(2000) }),
  z.object({
    op: z.literal('create'), jobId: Uuid, title: z.string().trim().min(1, 'Name the submittal.').max(200), specSection: Opt(z.string().trim().max(20)),
    submittalType: z.enum(['SHOP_DRAWING', 'PRODUCT_DATA', 'SAMPLE', 'MOCKUP', 'OM_MANUAL', 'WARRANTY', 'CERTIFICATE', 'TEST_REPORT', 'CALCULATIONS', 'SUSTAINABILITY', 'OTHER']).default('PRODUCT_DATA'), requiredOnSite: Opt(IsoDate), leadTimeDays: Opt(z.number().int().min(0).max(730)), reviewDays: Opt(z.number().int().min(0).max(120)),
    responsibleVendorId: Opt(Uuid),
  }),
]);
const Reviewer = z.object({ kind: z.enum(['SUB', 'GC', 'ARCHITECT', 'ENGINEER', 'CONSULTANT', 'OWNER']), name: Opt(Text200), membership: Opt(Uuid), due_days: z.number().int().min(1).max(60).optional() });
export const SubmittalAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('submit'), reviewers: z.array(Reviewer).min(1, 'Add the review path.').max(8) }),
  z.object({ op: z.literal('respond'), reviewId: Uuid, code: z.enum(['APPROVED', 'APPROVED_AS_NOTED', 'REVISE_RESUBMIT', 'REJECTED', 'FOR_RECORD']), comments: Note, stamp: Opt(Text200) }),
  z.object({ op: z.literal('revise') }),
  z.object({ op: z.literal('release'), on: Opt(IsoDate) }),
  z.object({ op: z.literal('dates'), requiredOnSite: Opt(IsoDate), leadTimeDays: Opt(z.number().int().min(0).max(730)), reviewDays: Opt(z.number().int().min(0).max(120)) }),
]);

export const MeetingCreate = z.object({
  jobId: Uuid,
  meetingType: z.enum(['OAC', 'SUB_COORDINATION', 'PRECONSTRUCTION', 'PREINSTALLATION', 'SAFETY', 'CLOSEOUT', 'OTHER']).default('OAC'),
  title: z.string().trim().min(1, 'Name the meeting.').max(200),
  scheduledAt: Opt(z.string().datetime({ offset: true })),
  locationText: Opt(Text200),
  agenda: Opt(z.string().trim().max(8000)),
});
export const MeetingAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('next'), scheduledAt: Opt(z.string().datetime({ offset: true })) }),
  z.object({ op: z.literal('distribute') }),
  z.object({ op: z.literal('minutes'), minutes: z.string().trim().max(40000) }),
  z.object({ op: z.literal('attendee'), name: z.string().trim().min(1).max(120), company: Opt(Text200), email: Opt(z.string().trim().email().max(200)), role: Opt(Text200) }),
  z.object({ op: z.literal('item'), topic: z.string().trim().min(1, 'What is the item?').max(300), description: Note, ownerName: Opt(Text200), ownerCompany: Opt(Text200), dueOn: Opt(IsoDate) }),
  z.object({ op: z.literal('item_status'), itemId: Uuid, status: z.enum(['OPEN', 'CLOSED', 'DEFERRED']) }),
]);

// ------------------------------------------------------------------ daily log
export const DailyLogOpen = z.object({ jobId: Uuid, logDate: IsoDate, copyForward: z.boolean().default(true) });
export const LogEntry = z.object({
  kind: z.enum(['MANPOWER', 'EQUIPMENT', 'DELIVERY', 'DELAY', 'VISITOR', 'INSPECTION', 'WORK', 'NOTE', 'SAFETY']),
  vendorId: Opt(Uuid), companyName: Opt(z.string().trim().max(120)), trade: Opt(z.string().trim().max(80)),
  headcount: Opt(z.number().int().min(0).max(999)), hours: Opt(z.number().min(0).max(9999)),
  equipment: Opt(z.string().trim().max(120)), equipmentHours: Opt(z.number().min(0).max(999)),
  supplier: Opt(z.string().trim().max(120)), description: Opt(z.string().trim().max(4000)),
  cause: Opt(z.enum(['WEATHER', 'OWNER', 'DESIGN', 'SUB', 'MATERIAL', 'INSPECTION', 'LABOR', 'ACCESS', 'OTHER'])),
  durationHours: Opt(z.number().min(0).max(240)), responsibleParty: Opt(z.string().trim().max(120)), noticeSent: Opt(z.boolean()),
  inspector: Opt(z.string().trim().max(120)), result: Opt(z.enum(['PASS', 'FAIL', 'PARTIAL'])),
});
export const DailyLogAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('header'), weatherSummary: Opt(z.string().trim().max(120)), tempHighF: Opt(z.number().int().min(-60).max(140)), tempLowF: Opt(z.number().int().min(-60).max(140)),
    precipitation: Opt(z.string().trim().max(60)), wind: Opt(z.string().trim().max(60)), siteConditions: Opt(z.string().trim().max(2000)), workPerformed: Opt(z.string().trim().max(20000)), safetyNotes: Opt(z.string().trim().max(4000)) }),
  z.object({ op: z.literal('entry'), entry: LogEntry }),
  z.object({ op: z.literal('remove_entry'), entryId: Uuid }),
  z.object({ op: z.literal('sign'), signerName: Opt(Text200) }),
  z.object({ op: z.literal('amend'), reason: z.string().trim().min(1, 'Say why the signed log is amended.').max(2000), entry: LogEntry }),
  z.object({ op: z.literal('voice'), transcript: z.string().trim().min(3, 'Say what happened today.').max(20000), language: z.enum(['en', 'es']).default('en') }),
  z.object({ op: z.literal('apply_voice'), voiceId: Uuid, entries: z.array(z.record(z.unknown())).max(100) }),
]);

// ------------------------------------------------------------------ closeout / trade / platform
export const CloseoutAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('generate'), jobId: Uuid }),
  z.object({ op: z.literal('close'), jobId: Uuid, note: Note }),
  z.object({ op: z.literal('item'), itemId: Uuid, status: z.enum(['REQUIRED', 'REQUESTED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'WAIVED']) }),
]);
export const TemplateAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('apply'), jobId: Uuid, templateId: Uuid }),
  z.object({ op: z.literal('push'), templateId: Uuid }),
  z.object({ op: z.literal('seed'), companyId: Uuid }),
]);
export const ProposalAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('send'), proposalId: Uuid, envelopeId: Opt(Uuid) }),
  z.object({ op: z.literal('accept'), proposalId: Uuid, jobTypeKey: z.string().trim().min(1).max(60), alternates: z.array(z.number().int().min(1).max(99)).max(30).default([]) }),
]);
export const ProductivityAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('quantity'), jobId: Uuid, costCodeId: Uuid, workDate: IsoDate, qty: z.number().min(0).max(1e8), note: Note }),
  z.object({ op: z.literal('fade'), jobId: Uuid, weekStart: Opt(IsoDate) }),
]);

// ------------------------------------------------------------------ quality / safety
export const ObservationCreate = z.object({
  jobId: Uuid,
  obsType: z.enum(['QUALITY', 'SAFETY', 'COMMISSIONING', 'ENVIRONMENTAL', 'WARRANTY']).default('QUALITY'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  title: z.string().trim().min(1, 'What was observed?').max(200),
  description: Note,
  hazard: Opt(Text200),
  assigneeVendorId: Opt(Uuid),
  assigneeName: Opt(Text200),
  dueOn: Opt(IsoDate),
});
export const ObservationAction = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CLOSED', 'VOID']) });
export const InspectionStart = z.object({ jobId: Uuid, templateId: Uuid, title: Opt(Text200), area: Opt(Text200) });
export const InspectionAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('item'), itemId: Uuid, response: z.enum(['PASS', 'FAIL', 'NA']), note: Note, value: Opt(Text200) }),
  z.object({ op: z.literal('complete'), signerName: Opt(Text200), signaturePng: Opt(z.string().max(200_000)) }),
]);
export const SafetyAction = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('toolbox'), jobId: Uuid, heldOn: IsoDate, topic: z.string().trim().min(1, 'Name the topic.').max(200), language: z.enum(['en', 'es']).default('en'),
    presenterName: Opt(Text200), notes: Note, attendees: z.array(z.object({ name: z.string().trim().min(1).max(120), company: Opt(Text200) })).max(200).default([]),
  }),
  z.object({
    op: z.literal('jha'), jobId: Uuid, workDate: IsoDate, task: z.string().trim().min(1, 'Describe the task.').max(500), area: Opt(Text200),
    steps: z.array(z.object({ step: z.string().trim().min(1).max(300), hazard: z.string().trim().max(300).default(''), control: z.string().trim().max(300).default('') })).max(40).default([]),
    ppe: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  }),
  z.object({ op: z.literal('sign_jha'), jhaId: Uuid, signoffs: z.array(z.object({ name: z.string().trim().min(1).max(120), company: Opt(Text200) })).min(1).max(100) }),
  z.object({
    op: z.literal('incident'), jobId: Uuid, incidentType: z.enum(['INJURY', 'ILLNESS', 'PROPERTY_DAMAGE', 'NEAR_MISS', 'ENVIRONMENTAL', 'VEHICLE']),
    occurredAt: z.string().datetime({ offset: true }), personName: Opt(Text200), jobTitle: Opt(Text200), company: Opt(Text200), isEmployee: z.boolean().default(true),
    description: z.string().trim().min(1, 'Describe what happened.').max(20000), whereOccurred: Opt(Text200), bodyPart: Opt(Text200), injuryNature: Opt(Text200),
    oshaRecordable: Opt(z.boolean()), oshaClassification: Opt(z.enum(['DEATH', 'DAYS_AWAY', 'RESTRICTED_OR_TRANSFER', 'OTHER_RECORDABLE'])),
    injuryOrIllness: Opt(z.enum(['INJURY', 'SKIN_DISORDER', 'RESPIRATORY', 'POISONING', 'HEARING_LOSS', 'OTHER_ILLNESS'])),
    daysAway: z.number().int().min(0).max(180).default(0), daysRestricted: z.number().int().min(0).max(180).default(0),
  }),
]);

// ------------------------------------------------------------------ transmittals / correspondence / workforce
export const DocControlAction = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('transmittal'), jobId: Uuid, subject: z.string().trim().min(1, 'Give it a subject.').max(200), toName: Opt(Text200), toCompany: Opt(Text200),
    toEmail: Opt(z.string().trim().email().max(200)), purpose: z.enum(['FOR_APPROVAL', 'FOR_REVIEW', 'FOR_INFORMATION', 'FOR_CONSTRUCTION', 'AS_REQUESTED', 'FOR_RECORD']).default('FOR_REVIEW'),
    items: z.array(z.object({ description: z.string().trim().min(1).max(300), copies: z.number().int().min(1).max(99).default(1), document_id: Opt(Uuid) })).max(100).default([]),
    notes: Note,
  }),
  z.object({
    op: z.literal('letter'), jobId: Uuid, corrType: z.enum(['LETTER', 'NOTICE_OF_DELAY', 'NOTICE_OF_CLAIM', 'BACKCHARGE_NOTICE', 'NOTICE_OF_DEFAULT', 'NOTICE_TO_PROCEED', 'NOTICE_OF_DISPUTE', 'MEMO', 'EMAIL', 'OTHER']).default('LETTER'),
    direction: z.enum(['OUTGOING', 'INCOMING']).default('OUTGOING'), subject: z.string().trim().min(1, 'Give it a subject.').max(200), body: Opt(z.string().trim().max(40000)),
    fromName: Opt(Text200), toName: Opt(Text200), toCompany: Opt(Text200), sentOn: Opt(IsoDate), responseRequiredBy: Opt(IsoDate), changeEventId: Opt(Uuid),
  }),
]);
export const WorkforceAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('request'), companyId: Uuid, jobId: Uuid, trade: Opt(Text200), role: z.enum(['FOREMAN', 'JOURNEYMAN', 'APPRENTICE', 'HELPER', 'OPERATOR', 'OTHER']).default('JOURNEYMAN'), headcount: z.number().int().min(1).max(500), startWeek: IsoDate, endWeek: IsoDate, note: Note }),
  z.object({ op: z.literal('assign'), companyId: Uuid, jobId: Uuid, employeeId: Uuid, requestId: Opt(Uuid), role: z.enum(['FOREMAN', 'JOURNEYMAN', 'APPRENTICE', 'HELPER', 'OPERATOR', 'OTHER']).default('JOURNEYMAN'), weekStart: IsoDate, days: z.number().int().min(0).max(7).default(5), perDiem: z.boolean().default(false), travel: z.boolean().default(false), note: Note }),
]);
