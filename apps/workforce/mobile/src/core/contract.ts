/**
 * The phone side of the Merit Projects field contract. Mirrors
 * apps/projects/src/app/api/field/_lib/contract.ts (the server validates with Zod; keep the two
 * in step). Pure types: no React Native imports.
 *
 * No money anywhere: no command or response carries a rate, cost, price or amount.
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

export type JsonCommand = ClockCommand | TimeUpdateCommand | TimeSubmitCommand | LogSubmitCommand | ChecklistSubmitCommand | PunchCreateCommand | CrewApproveCommand;
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
