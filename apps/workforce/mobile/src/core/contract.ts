/**
 * The phone side of the Merit Projects field contract. Mirrors
 * apps/projects/src/app/api/field/_lib/contract.ts (the server validates with Zod; keep the two
 * in step). Pure types: no React Native imports.
 *
 * No JOB money anywhere: no command or response carries a rate, cost, budget or margin. The only
 * amounts on the phone are (1) the customer-facing prices a technician presents at the kitchen
 * table (SellBundle, FsSellCommand.depositCents), (2) the person's OWN pay (PayWeek, Books cards)
 * and (3) an approval amount the server shows only when it is the approver's to see.
 */

export interface Geo {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

/** Fields every command carries. `id` is the idempotency key; `at` is when it happened on the phone. */
export interface Envelope {
  id: string;
  at: string;
  tz?: string | null;
  geo?: Geo | null;
  offline?: boolean;
}

export type ClockEvent = 'EN_ROUTE' | 'IN' | 'BREAK_START' | 'BREAK_END' | 'OUT' | 'SWITCH';
export const CLOSING_EVENTS: ReadonlySet<ClockEvent> = new Set<ClockEvent>(['BREAK_START', 'OUT', 'SWITCH']);

export interface Segment {
  startId: string;
  startAt: string;
  startGeo?: Geo | null;
}

export interface ClockCommand extends Envelope {
  kind: 'clock';
  event: ClockEvent;
  jobId: string;
  costCodeId?: string | null;
  assignmentId?: string | null;
  crewEmployeeIds?: string[];
  segment?: Segment | null;
  notes?: string | null;
}

export interface TimeUpdateCommand extends Envelope {
  kind: 'time.update';
  entryId: string;
  hours?: number;
  costCodeId?: string | null;
  workDate?: string;
  notes?: string | null;
}

export interface TimeSubmitCommand extends Envelope {
  kind: 'time.submit';
  entryIds: string[];
}

export interface Signature {
  name: string;
  path?: string | null;
  signedAt: string;
}

export interface Weather {
  conditions?: string | null;
  highF?: number | null;
  lowF?: number | null;
  precipitation?: string | null;
  delay?: boolean;
  source?: 'auto' | 'typed';
}

export interface LogSubmitCommand extends Envelope {
  kind: 'log.submit';
  jobId: string;
  logDate: string;
  logKind?: 'DAILY' | 'SAFETY' | 'DELIVERY' | 'VISIT';
  body?: string | null;
  weather?: Weather | null;
  crewCount?: number | null;
  hours?: number | null;
  signature?: Signature | null;
}

export type CheckResult = 'PASS' | 'FAIL' | 'NA';

export interface ChecklistSubmitCommand extends Envelope {
  kind: 'checklist.submit';
  jobId: string;
  templateKey: string;
  items: Array<{ key: string; result: CheckResult; note?: string | null; photoIds: string[] }>;
  signature?: Signature | null;
}

export interface PunchCreateCommand extends Envelope {
  kind: 'punch.create';
  jobId: string;
  title: string;
  description?: string | null;
  area?: string | null;
  dueOn?: string | null;
  fromChecklist?: { commandId: string; itemKey: string } | null;
}

export interface CrewApproveCommand extends Envelope {
  kind: 'crew.approve';
  entryIds: string[];
}

export interface PhotoCommand extends Envelope {
  kind: 'photo.upload';
  jobId: string;
  caption?: string | null;
  attachTo?: { kind: 'log' | 'checklist' | 'punch'; commandId: string } | null;
}

// ------------------------------------------------------------- v2 phone commands (Wave C)
// Mirror of apps/projects/src/app/api/field/_lib/phone-contract.ts. Same envelope, same queue,
// same POST /api/field/sync batch; the server applies each at most once.

export interface ApprovalDecideCommand extends Envelope {
  kind: 'approval.decide';
  requestId: string;
  decision: 'approve' | 'reject';
  reason?: string | null;
  selfReason?: string | null;
  /** The round and step this phone saw (a re-send after the step moved on is recognised). */
  round: number;
  step: number;
}

export interface NotificationMarkCommand extends Envelope {
  kind: 'notification.mark';
  ids: string[];
  state: 'read' | 'done';
}

export const KIOSK_ACTIONS = ['START', 'STOP', 'PAUSE', 'COMPLETE', 'INDIRECT_START', 'INDIRECT_STOP', 'REMAKE'] as const;
export type KioskAction = (typeof KIOSK_ACTIONS)[number];

export interface KioskEventCommand extends Envelope {
  kind: 'kiosk.event';
  companyId: string;
  sessionToken: string;
  action: KioskAction;
  operationId?: string | null;
  goodQty?: number | null;
  scrapQty?: number | null;
  qty?: number | null;
  reason?: string | null;
  indirectCode?: string | null;
}

export const RO_INDIRECT = ['SHOP', 'WAITING_PARTS', 'TRAINING', 'CLEANUP', 'IDLE'] as const;
export type RoIndirect = (typeof RO_INDIRECT)[number];

export interface RoClockCommand extends Envelope {
  kind: 'ro.clock';
  op: 'clock_on' | 'clock_off' | 'indirect';
  companyId: string;
  lineId?: string | null;
  indirectKind?: RoIndirect | null;
}

export interface RoStoryCommand extends Envelope {
  kind: 'ro.story';
  workOrderId: string;
  lineId?: string | null;
  complaint?: string | null;
  cause?: string | null;
  correction?: string | null;
}

export interface EsignSignCommand extends Envelope {
  kind: 'esign.sign';
  token: string;
  typedName: string;
  signaturePng: string;
  consent: true;
}

export type DepositMethod = 'none' | 'link' | 'check' | 'cash';

/**
 * The kitchen-table close (POST /api/field/fs-commands, pm.fs_field_sell). depositCents is the
 * customer's deposit (customer-facing), never a cost. signedAt = when the customer signed.
 */
export interface FsSellCommand extends Envelope {
  kind: 'fs.sell';
  estimateId: string;
  /** Older queued sales may lack it; the phone sends `at` then. */
  signedAt?: string;
  optionIds: string[];
  toggles: Array<{ itemId: string; selected: boolean }>;
  signedName: string;
  signaturePhotoId?: string | null;
  financingPlanId?: string | null;
  joinTemplateId?: string | null;
  depositCents: number;
  depositMethod: DepositMethod;
  depositRef?: string | null;
  dismissReason?: string | null;
}

export interface FsDeclineCommand extends Envelope {
  kind: 'fs.decline';
  estimateId: string;
  reason: string;
}

// ---- Field-service tools (C2, POST /api/field/fs-commands; lib/fieldservice/field-commands.ts).
// Each 1123 RPC takes the command id and applies it at most once in the same transaction.

export type FormAnswer = string | number | boolean | string[] | null;

export interface FsFormSubmitCommand extends Envelope {
  kind: 'fs.form.submit';
  workOrderId: string;
  templateId: string;
  answers: Record<string, FormAnswer>;
  signedName?: string | null;
  /** SVG path data of the drawn signature (the server's own format). */
  signaturePath?: string | null;
  /** Photo COMMAND ids taken for this form (uploaded separately). */
  photoIds: string[];
  redTagReason?: string | null;
}

export interface FsNoteSaveCommand extends Envelope {
  kind: 'fs.note.save';
  workOrderId: string;
  source: 'VOICE' | 'TYPED';
  transcript?: string | null;
  fields?: { diagnosis?: string | null; work_performed?: string | null; recommendations?: string | null; customer_summary?: string | null } | null;
  photoIds: string[];
  photoCaptions: Record<string, string>;
}

export interface FsEquipmentCommand extends Envelope {
  kind: 'fs.equipment.upsert';
  workOrderId: string;
  assetId?: string | null;
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  equipmentType?: string | null;
  manufacturedOn?: string | null;
  tonnage?: number | null;
  refrigerantType?: string | null;
  fuelType?: 'GAS' | 'PROPANE' | 'ELECTRIC' | 'OIL' | 'DUAL' | 'OTHER' | null;
  nameplatePhotoId?: string | null;
}

export interface FsWillCallCommand extends Envelope {
  kind: 'fs.willcall.pickup';
  commitmentId: string;
  pickupCode: string;
  lines: Array<{ lineId: string; qty: number; serials: string[] }>;
}

export interface FsPayLinkCommand extends Envelope {
  kind: 'fs.paylink.send';
  reviewId: string;
  channel: 'SMS' | 'EMAIL';
}

export interface FsMessageCommand extends Envelope {
  kind: 'fs.message.send';
  companyId: string;
  customerId: string;
  jobId: string;
  workOrderId: string;
  body: string;
}

export type FsToolCommand = FsFormSubmitCommand | FsNoteSaveCommand | FsEquipmentCommand | FsWillCallCommand | FsPayLinkCommand | FsMessageCommand;

// ---- Flooring installer (C3, POST /api/field/flooring {op}). Replays are safe: "on my way" texts at
// most once a day per booking; a second sign-off of a closed booking changes nothing (answered as
// already done); the on-site change carries its command id (pm.wc_field_commands). Receipts
// (POST /api/field/receipts) dedupe on clientId = the command id (unique per org).

/** A document id the server needs that the phone only knows as a queued photo: filled in at send time. */
export interface DocRef {
  field: 'signatureDocumentId' | 'photoDocumentIds';
  photoId: string;
}

export interface FlrOnMyWayCommand extends Envelope {
  kind: 'flr.omw';
  bookingId: string;
}

export interface FlrSignoffCommand extends Envelope {
  kind: 'flr.signoff';
  bookingId: string;
  signerName: string;
  notes?: string | null;
  signatureDocumentId?: string | null;
  photoDocumentIds?: string[];
  /** Roll goods coming back to the warehouse (inches left per roll). */
  leftover?: Array<{ roll_id: string; len_in: number }>;
  docRefs: DocRef[];
}

export interface FlrChangeCommand extends Envelope {
  kind: 'flr.change';
  jobId: string;
  lines: Array<{ labor_code: string; qty: number; description?: string | null }>;
  signerName?: string | null;
  note?: string | null;
  signatureDocumentId?: string | null;
  docRefs: DocRef[];
}

export type FlooringCommand = FlrOnMyWayCommand | FlrSignoffCommand | FlrChangeCommand;

export interface ResReceiptCommand extends Envelope {
  kind: 'res.receipt';
  jobId: string;
  /** The queued photo's command id: the server links the receipt to it when it lands. */
  photoCommandId: string;
  vendorName?: string | null;
  amountCents?: number | null;
  purchasedOn?: string | null;
  memo?: string | null;
}

/** 3C story on one RO line (POST /api/field/ro/story, pm.dlr_set_line_story; idempotent by command id). */
export interface RoLineStoryCommand extends Envelope {
  kind: 'ro.line.story';
  workOrderId: string;
  lineId: string;
  complaint?: string | null;
  cause?: string | null;
  correction?: string | null;
}

export type PhoneCommand = ApprovalDecideCommand | NotificationMarkCommand | KioskEventCommand | RoClockCommand | RoStoryCommand | EsignSignCommand | FsSellCommand | FsDeclineCommand | FsToolCommand | FlooringCommand | ResReceiptCommand | RoLineStoryCommand;

export type JsonCommand = ClockCommand | TimeUpdateCommand | TimeSubmitCommand | LogSubmitCommand | ChecklistSubmitCommand | PunchCreateCommand | CrewApproveCommand | PhoneCommand;
export type Command = JsonCommand | PhotoCommand;
export type CommandKind = Command['kind'];

/** A command before the queue stamps it (the queue adds id, at, tz, geo, offline). */
export type Draft<C extends Command> = Omit<C, keyof Envelope> & Partial<Pick<Envelope, 'geo'>>;

export type CommandOutcome = 'applied' | 'duplicate' | 'rejected' | 'retry';

export interface CommandResult {
  id: string;
  kind: string;
  outcome: CommandOutcome;
  serverId?: string | null;
  serverIds?: string[];
  code?: string;
  reason?: string;
  note?: string;
}

export const MAX_BATCH = 50;

// ------------------------------------------------------------------------- GET /api/field/today

export interface Bilingual {
  en: string;
  es: string;
}

export interface ChecklistTemplate {
  key: string;
  title: Bilingual;
  logKind: 'INSPECTION' | 'SAFETY';
  items: Array<{ key: string; text: Bilingual; photo: 'required' | 'on_fail' | 'optional' }>;
}

export interface FieldJob {
  id: string;
  number: string | null;
  name: string;
  companyId: string;
  company: string | null;
  customer: string | null;
  stage: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  checklists: string[];
}

export interface FieldAssignment {
  id: string;
  jobId: string;
  workOrderId: string;
  title: string;
  status: 'ASSIGNED' | 'DISPATCHED' | 'EN_ROUTE' | 'ON_SITE' | 'DONE' | 'CANCELLED';
  start: string | null;
  end: string | null;
  day: string | null;
  crew: boolean;
}

export interface FieldTask {
  id: string;
  jobId: string;
  title: string;
  status: string;
  startOn: string | null;
  dueOn: string | null;
  costCodeId: string | null;
  mine: boolean;
}

export type ApprovalState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'VOID';

export interface FieldTimeEntry {
  id: string;
  jobId: string;
  employeeId: string | null;
  workDate: string;
  hours: number;
  costCodeId: string | null;
  notes: string | null;
  state: ApprovalState;
  /** 'wf:seg:<clock-in command id>' when the phone made it. */
  commandRef: string | null;
  updatedAt: string | null;
}

export interface FieldToday {
  serverTime: string;
  timeZone: string;
  today: string;
  days: string[];
  weekStart: string;
  me: { employeeId: string | null; name: string; persona: string; title: string; group: string };
  can: { approveTime: boolean; crewClock: boolean; punch: boolean; logs: boolean; photos: boolean; time: boolean };
  booksPresent: boolean;
  jobs: FieldJob[];
  assignments: FieldAssignment[];
  tasks: FieldTask[];
  costCodes: Array<{ id: string; companyId: string; jobId: string | null; code: string; name: string }>;
  checklists: ChecklistTemplate[];
  week: FieldTimeEntry[];
  crew: Array<{ employeeId: string; name: string; crewId: string; crewName: string }>;
  crewTime: Array<FieldTimeEntry & { person: string }>;
  punch: Array<{ id: string; jobId: string; title: string; status: string; area: string | null; dueOn: string | null }>;
}

// ------------------------------------------------------------- v2 reads (Wave C)

/** GET /api/approvals?mine — one row of my queue (amount_cents is null when the money is not mine to see). */
export interface ApprovalItem {
  id: string;
  object_type: string;
  object_id: string;
  object_ref: string | null;
  company: string | null;
  job_id: string | null;
  job_label: string | null;
  title: string;
  summary: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  amount_cents: number | null;
  money_visible: boolean;
  facts: { over_budget?: boolean; below_margin_floor?: boolean; overtime?: boolean; hours?: number; week_hours?: number; lines?: number; failing_guards?: string[] };
  step: number;
  step_count: number;
  round: number;
  step_label: string | null;
  escalated: boolean;
  due_at: string | null;
  overdue: boolean;
  submitted_at: string;
  submitted_by: string | null;
  can_act: boolean;
  on_behalf_of: string | null;
  self_approval: boolean;
  needs_reason: boolean;
}

export interface ApprovalInbox {
  items: ApprovalItem[];
  counts: { mine: number; mine_overdue: number; waiting: number };
}

/** GET /api/notifications?view=inbox — my rows, already masked per recipient by the database. */
export interface InboxItem {
  id: string;
  kind: string;
  eventType: string | null;
  sourceApp: 'books' | 'projects' | 'suite';
  severity: 'info' | 'attention' | 'critical';
  title: string;
  body: string | null;
  deepLink: string | null;
  jobId: string | null;
  jobLabel: string | null;
  itemCount: number;
  readAt: string | null;
  doneAt: string | null;
  createdAt: string;
}

export interface InboxPage {
  items: InboxItem[];
  nextBefore: string | null;
  unread: number;
}

export interface HomeNotes {
  lockboxCode: string | null;
  gateCode: string | null;
  garageCode: string | null;
  alarmCode: string | null;
  pets: string | null;
  children: string | null;
  workHours: string | null;
  parking: string | null;
  offLimits: string | null;
  utilityNotice: string | null;
  tempKitchen: string | null;
  bathroomForCrew: string | null;
  notes: string | null;
  occupied: boolean;
  rrpRequired: boolean;
}

export interface VisitExtra {
  kind: string;
  number: string | null;
  status: string;
  complaint: string | null;
  gateCode: string | null;
  pets: string | null;
  accessNotes: string | null;
  member: boolean;
  estimates: { open: number; sold: number };
}

/** Residential "Today" (pm.res_field_sites): deliveries today / tomorrow, open protection checks. */
export interface SiteToday {
  deliveries: Array<{ description: string; expectedOn: string | null; status: string }>;
  checksOpen: number;
  rrpOpen: boolean;
}

/** GET /api/field/extras — what Wave C adds to today's cached work. No money. */
export interface FieldExtras {
  serverTime: string;
  visits: Record<string, VisitExtra>;
  homes: Record<string, HomeNotes>;
  /** Absent from servers before 1124. */
  sites?: Record<string, SiteToday>;
  drawings: Record<string, number>;
  features: { approvals: boolean; esign: boolean; drawings: boolean; kiosk: boolean; roClock: boolean; installerPay: boolean };
  stations: Array<{ companyId: string; name: string }>;
}

/** GET /api/field/drawings — the current revision of each sheet (url signed for one hour). */
export interface PhoneSheet {
  sheetId: string;
  jobId: string;
  number: string;
  title: string | null;
  discipline: string | null;
  revisionId: string;
  revisionLabel: string | null;
  setName: string;
  issuedOn: string | null;
  url: string | null;
  bytes: number | null;
}

/** GET /api/field/sell — customer-facing prices only (never cost, never the dealer fee). */
export interface SellOption {
  id: string;
  estimateId: string;
  tier: 'GOOD' | 'BETTER' | 'BEST' | 'OPTION';
  name: string;
  description: string | null;
  recommended: boolean;
  status: 'OPEN' | 'SOLD' | 'DISMISSED';
  rebateCents: number;
  rebateNote: string | null;
  financingPlanId: string | null;
  regularCents: number;
  memberCents: number;
}

export interface SellItem {
  id: string;
  optionId: string;
  description: string;
  qty: number;
  unitPriceCents: number;
  memberUnitPriceCents: number | null;
  optional: boolean;
  selected: boolean;
}

export interface FinancingPlan {
  id: string;
  provider: string;
  name: string;
  apr: number;
  termMonths: number;
  promo: string | null;
  minCents: number;
  maxCents: number | null;
  isDefault: boolean;
}

export interface MembershipPlan {
  id: string;
  planName: string;
  tier: string | null;
  termMonths: number;
  priceCents: number;
  billingFrequency: string;
  memberDiscountPct: number;
  visitsPerTerm: number;
}

export interface SellBundle {
  workOrderId: string;
  jobId: string;
  companyId: string;
  member: boolean;
  customer: string | null;
  estimates: Array<{ id: string; number: string | null; title: string; status: 'DRAFT' | 'PRESENTED' | 'SOLD' | 'DECLINED' | 'EXPIRED'; member_pricing: boolean; signed_name: string | null; signed_at: string | null; deposit_cents: number }>;
  options: SellOption[];
  items: SellItem[];
  plans: FinancingPlan[];
  memberships: MembershipPlan[];
}

/** GET /api/field/ro — dealer tech. Hours only. */
export interface RoBundle {
  serverTime: string;
  stores: Array<{ companyId: string; name: string }>;
  ros: Array<{ id: string; number: string | null; summary: string; status: string; jobId: string; companyId: string; mine: boolean }>;
  lines: Array<{ id: string; workOrderId: string; description: string; laborOp: string | null; flagHours: number | null; status: string }>;
  open: { companyId: string; lineId: string | null; kind: string; startedAt: string } | null;
}

/** GET /api/field/pay — the installer's OWN pay this week (the only money on the phone that is theirs). */
export interface PayWeek {
  installer: boolean;
  weekStart: string;
  weekEnd: string;
  tickets: Array<{
    id: string; number: string | null; jobId: string; job: string | null; completedOn: string; status: string; splitPct: number | null;
    grossCents: number | null; chargebackCents: number | null; netCents: number | null;
    lines: Array<{ laborCode: string; description: string | null; unit: string | null; qty: number; amountCents: number | null; overMeasured: boolean }>;
  }>;
  chargebacks: Array<{ id: string; reason: string; description: string | null; amountCents: number | null; status: string; createdAt: string }>;
  totals: { grossCents: number; chargebackCents: number; netCents: number; approvedNetCents: number };
}

export interface SignableFile {
  id: string;
  title: string;
  kind: string;
  fileName: string | null;
  updatedAt: string;
  signature: 'sent' | 'completed' | 'declined' | null;
}

/** POST /api/field/sign — an in-person signing session for this phone only. */
export interface StartedSigning {
  envelopeId: string;
  token: string;
  fileUrl: string;
  state: {
    ok: boolean;
    reason: string | null;
    document?: { title: string; file_name: string; page_count: number | null; kind: string };
    company?: { company_name: string; org_name: string | null; logo_url: string | null; primary_color: string; ink_color: string; on_primary_color: string };
    signer?: { id: string; name: string; role_label?: string | null };
    consent?: { version: string; text: string };
    envelope?: { id: string; title: string; expires_at?: string };
  };
}

/** POST /api/mfg/kiosk {op:'identify'} — a worker's badge session at the station (online). No money. */
export interface KioskSession {
  ok: true;
  session_token: string;
  expires_at: string;
  employee_id: string;
  name: string | null;
  open: Array<{ punch_id: string; operation_id: string | null; indirect_code: string | null; started_at: string; work_order: string | null; operation: string | null }>;
  operations: Array<{ operation_id: string; work_order_id: string; work_order: string | null; summary: string; job: string | null; seq: number; operation: string; work_center: string; status: string; assigned_to_me: boolean; qty: number | null }>;
}

// ------------------------------------------------------------- C2 / C3 reads

export interface FormField {
  key: string;
  label?: string;
  type?: 'reading' | 'number' | 'pass_fail' | 'check' | 'choice' | 'text' | 'photo';
  unit?: string;
  min?: number;
  max?: number;
  required?: boolean;
  options?: string[];
  red_tag_on_fail?: boolean;
  red_tag_above?: number;
  red_tag_below?: number;
}

export interface FsFormTemplate {
  id: string;
  key: string;
  name: string;
  kind: string;
  fields: FormField[];
  version: number;
  requires_signature: boolean;
  suggested: boolean;
  submitted: boolean;
}

export interface WillCall {
  commitment_id: string;
  number: string;
  title: string | null;
  status: string;
  job_id: string;
  vendor: string | null;
  pickup_code: string | null;
  expected_on: string | null;
  note: string | null;
  ready: boolean;
  lines: Array<{ line_id: string; description: string; qty: number | null; received_qty: number }>;
}

/** GET /api/field/fs-tools?workOrderId= — no money. */
export interface FsTools {
  workOrderId?: string;
  jobId?: string;
  customerId?: string | null;
  /** Only for callers who may read invoice reviews; the pay link only when canSendPayLink. */
  invoiceReview?: { id: string; status: string; flagCount: number; blockingCount: number; invoiced: boolean; canSendPayLink: boolean; totalCents: number | null } | null;
  forms?: FsFormTemplate[];
  notes?: Array<{ id: string; source: string; diagnosis: string | null; work_performed: string | null; recommendations: string | null; customer_summary: string | null; created_at: string }>;
  equipment?: Array<{ asset_id: string; equipment_type: string | null; make: string | null; model: string | null; serial_number: string | null; age_years: number | null; parts_warranty_ends_on: string | null; labor_warranty_ends_on: string | null; parts_covered: boolean | null }>;
  willCalls: WillCall[];
}

/** GET /api/field/site — the lead carpenter's site cards (pm.res_field_sites). No money. */
export interface FieldSiteCard {
  job_id: string;
  job_number: string;
  name: string;
  address: string | null;
  codes: { lockbox?: string; gate?: string; garage?: string; alarm?: string };
  home: Record<string, string | boolean>;
  rrp: boolean;
  deliveries: Array<{ description: string; expected_on: string | null; status: string; tracking: string | null }>;
  checks_open: Array<{ id: string; kind: string; date: string }>;
  tasks_today: Array<{ id: string; title: string; status: string }>;
}

/** GET /api/field/flooring — the installer's day; the only money is their OWN pay this week. */
export interface InstallerDay {
  day: string;
  bookings: Array<{
    booking_id: string; job_id: string; job_number: string | null; job: string; status: string; sf: number | null; days: number;
    address: string | null; notes: string | null;
    areas: Array<{ room: string | null; kind: string | null; sqft: number | null; category: string | null }>;
    cuts: Array<{ cut_id?: string; roll_id?: string; roll: string | null; dye_lot: string | null; room: string | null; planned_len_in: number | null; status: string }>;
    /** The codes an on-site change may use (no rates on the phone). */
    labor_codes?: Array<{ code: string; description: string; unit: string; applies_to: string }>;
    site_checks_needed: string[];
  }>;
  my_pay_this_week_cents: number;
}
