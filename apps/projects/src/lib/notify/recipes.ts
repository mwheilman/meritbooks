/**
 * Notification recipes — the code mirror of migration 1114 (core.notification_event_types +
 * core.notification_recipes). Panel 06 §2e "Notification defaults by role":
 *   P = inbox + push · I = inbox · D = inbox + daily / weekly digest email · - = never.
 * A parity test (packages/projects-access/test/notifications.test.ts) fails when the two drift.
 * Pure and client-safe (the preferences screen reads it).
 */
import type { PersonaKey } from '@/lib/access/types';

export const NOTIFY_CHANNELS = ['in_app', 'push', 'email', 'sms'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
export type ChannelMode = 'instant' | 'digest' | 'off';

export const INTERNAL_EVENTS = [
  'job.assigned',
  'task.assigned',
  'punch.assigned',
  'schedule.changed',
  'time.submitted',
  'approval.requested',
  'approval.decided',
  'change_order.signed',
  'lead.assigned',
  'lead.sla_breach',
  'document.sign_requested',
  'comment.mention',
  // Wave B (1118 portals, 1119 residential, 1120 commercial) — every one mandatory
  'portal.activity',
  'change_order.requested',
  'trade.schedule_response',
  'rfi.assigned',
  'submittal.review_requested',
  'sub_pay_app.review',
  'compliance.expiring',
  'eac.submitted',
  'meeting.minutes',
  'meeting.item_assigned',
  'observation.assigned',
  'productivity.fade',
  'tm.signature_needed',
] as const;
export type InternalEvent = (typeof INTERNAL_EVENTS)[number];

export const CUSTOMER_EVENTS = [
  'customer.on_my_way',
  'customer.appointment_reminder',
  'customer.change_order_ready',
  'customer.selection_reminder',
  'customer.job_complete',
  'customer.message',
  // Wave B outbound to customers / trade partners (held until go-live, consent / STOP checked)
  'customer.portal_access',
  'trade.schedule_request',
  'trade.bid_invite',
  'trade.po_ready',
] as const;

/** Customer events whose messages may carry a sign-in link or one-time code (text never shown to staff). */
export const SECRET_BEARING_EVENTS = ['customer.portal_access'] as const;
export type CustomerEvent = (typeof CUSTOMER_EVENTS)[number];

export type NotifyEvent = InternalEvent | CustomerEvent;

/** Events the app may raise through pm.notify_emit (the rest are DB triggers / the worker). */
export const EMITTABLE_EVENTS = ['approval.requested', 'approval.decided', 'document.sign_requested', 'comment.mention'] as const;
export type EmittableEvent = (typeof EMITTABLE_EVENTS)[number];

export type EventCategory = 'work' | 'approvals' | 'sales' | 'schedule' | 'time' | 'documents' | 'comments';

export interface EventInfo {
  label: string;
  description: string;
  category: EventCategory;
  /** Platform-mandatory: the inbox copy cannot be turned off. */
  mandatory: boolean;
}

export const EVENT_INFO: Readonly<Record<InternalEvent, EventInfo>> = {
  'job.assigned': { label: 'Added to a job', description: 'Someone put you on a job team.', category: 'work', mandatory: false },
  'task.assigned': { label: 'Task assigned to you', description: 'A task on a job was assigned to you.', category: 'work', mandatory: false },
  'punch.assigned': { label: 'Punch item assigned to you', description: 'A punch, warranty or callback item was assigned to you.', category: 'work', mandatory: false },
  'schedule.changed': { label: 'Your schedule changed', description: 'Work assigned to you moved later.', category: 'schedule', mandatory: false },
  'time.submitted': { label: 'Time to approve', description: 'Crew time was submitted on a job you approve time for.', category: 'time', mandatory: false },
  'approval.requested': { label: 'Approval needed', description: 'Something is waiting for your approval.', category: 'approvals', mandatory: true },
  'approval.decided': { label: 'Approval decided', description: 'Something you sent for approval was approved or returned.', category: 'approvals', mandatory: false },
  'change_order.signed': { label: 'Change order signed', description: 'A change order on your job was signed.', category: 'approvals', mandatory: false },
  'lead.assigned': { label: 'Lead assigned to you', description: 'A new lead is yours to contact.', category: 'sales', mandatory: false },
  'lead.sla_breach': { label: 'Lead not contacted in time', description: "A lead has had no call, text or email within the company's speed-to-lead window.", category: 'sales', mandatory: false },
  'document.sign_requested': { label: 'Document to sign', description: 'A document is waiting for your signature.', category: 'documents', mandatory: false },
  'comment.mention': { label: 'Mentioned in a comment', description: 'Someone mentioned you in a comment.', category: 'comments', mandatory: false },
  'portal.activity': { label: 'Portal activity', description: 'A customer, sub, lender or investor acted in the portal (approved, declined, messaged, uploaded, proposed a date).', category: 'work', mandatory: true },
  'change_order.requested': { label: 'Change order requested from the field', description: 'A crew lead found something that needs a change order (work there is stopped until it is signed).', category: 'approvals', mandatory: true },
  'trade.schedule_response': { label: 'Trade answered a schedule request', description: 'A trade partner could not make a date or proposed another one.', category: 'schedule', mandatory: true },
  'rfi.assigned': { label: 'RFI waiting on you', description: "An RFI's ball in court moved to you.", category: 'work', mandatory: true },
  'submittal.review_requested': { label: 'Submittal to review', description: 'A submittal review step is waiting on you.', category: 'documents', mandatory: true },
  'sub_pay_app.review': { label: 'Sub pay application to review', description: 'A subcontractor pay application is at a step you approve.', category: 'approvals', mandatory: true },
  'compliance.expiring': { label: 'Insurance expiring', description: 'A subcontractor certificate of insurance is expiring or expired.', category: 'approvals', mandatory: true },
  'eac.submitted': { label: 'Cost forecast to approve', description: "A project manager submitted the month's cost forecast.", category: 'approvals', mandatory: true },
  'meeting.minutes': { label: 'Meeting minutes', description: 'Minutes of a meeting you attended were distributed.', category: 'work', mandatory: true },
  'meeting.item_assigned': { label: 'Meeting action item', description: 'An action item from a meeting is yours.', category: 'work', mandatory: true },
  'observation.assigned': { label: 'Observation assigned to you', description: 'A quality or safety observation was assigned to you.', category: 'work', mandatory: true },
  'productivity.fade': { label: 'Labor productivity fading', description: 'Earned hours fell behind hours used on a cost code.', category: 'time', mandatory: true },
  'tm.signature_needed': { label: 'T&M ticket to sign', description: "A T&M ticket is waiting for the GC's signature.", category: 'work', mandatory: true },
};

export type RecipePersona = PersonaKey | 'default';

export const RECIPE_PERSONAS = [
  'projects_owner',
  'projects_gm',
  'projects_office_manager',
  'projects_project_accountant',
  'projects_dispatcher',
  'projects_purchasing',
  'projects_pm',
  'projects_supervisor',
  'projects_labor',
  'projects_sales',
  'default',
] as const satisfies ReadonlyArray<RecipePersona>;

export type RecipeCode = 'P' | 'I' | 'D' | '-';

/** Same order as RECIPE_PERSONAS. Keep identical to the VALUES list in 1114 §3. */
export const RECIPE_CODES: Readonly<Record<InternalEvent, readonly RecipeCode[]>> = {
  //                        owner gm  om  pa  disp pur pm  sup lab sal default
  'job.assigned':            ['I', 'P', 'I', 'I', 'I', 'I', 'P', 'P', 'P', 'I', 'I'],
  'task.assigned':           ['I', 'I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I'],
  'punch.assigned':          ['I', 'I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I'],
  'schedule.changed':        ['-', '-', '-', '-', '-', '-', 'I', 'P', 'P', 'I', 'I'],
  'time.submitted':          ['D', 'D', 'D', 'D', '-', '-', 'I', 'P', '-', '-', 'I'],
  'approval.requested':      ['P', 'P', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I', 'I'],
  'approval.decided':        ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'I', 'I', 'P', 'I'],
  'change_order.signed':     ['D', 'P', 'D', 'I', '-', 'I', 'P', 'D', '-', 'P', 'I'],
  'lead.assigned':           ['I', 'I', 'I', 'I', 'P', 'I', 'I', 'I', 'I', 'P', 'I'],
  'lead.sla_breach':         ['D', 'I', 'I', '-', 'P', '-', '-', '-', '-', 'P', 'I'],
  'document.sign_requested': ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'I'],
  'comment.mention':         ['I', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'I'],
  // Wave B (mandatory: the floor is I)
  'portal.activity':            ['D', 'I', 'I', 'I', 'I', 'I', 'P', 'I', 'I', 'I', 'I'],
  'change_order.requested':     ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'I', 'I', 'I', 'I'],
  'trade.schedule_response':    ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I', 'I'],
  'rfi.assigned':               ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I', 'I'],
  'submittal.review_requested': ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I', 'I'],
  'sub_pay_app.review':         ['I', 'I', 'I', 'P', 'I', 'P', 'P', 'I', 'I', 'I', 'I'],
  'compliance.expiring':        ['D', 'D', 'I', 'I', 'I', 'P', 'I', 'I', 'I', 'I', 'I'],
  'eac.submitted':              ['P', 'P', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I'],
  'meeting.minutes':            ['D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D'],
  'meeting.item_assigned':      ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'P', 'I', 'I'],
  'observation.assigned':       ['I', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'P', 'I', 'I'],
  'productivity.fade':          ['D', 'I', 'I', 'I', 'I', 'I', 'P', 'P', 'I', 'I', 'I'],
  'tm.signature_needed':        ['I', 'I', 'I', 'I', 'I', 'I', 'I', 'P', 'I', 'I', 'I'],
};

export interface RecipeModes {
  in_app: 'instant' | 'off';
  push: 'instant' | 'off';
  email: ChannelMode;
  sms: 'instant' | 'off';
}

export function codeToModes(code: RecipeCode): RecipeModes {
  return {
    in_app: code === '-' ? 'off' : 'instant',
    push: code === 'P' ? 'instant' : 'off',
    email: code === 'D' ? 'digest' : 'off',
    sms: 'off',
  };
}

/** The role default for one persona and event. */
export function recipeFor(persona: RecipePersona, event: InternalEvent): RecipeModes {
  const i = RECIPE_PERSONAS.indexOf(persona);
  const code = RECIPE_CODES[event][i < 0 ? RECIPE_PERSONAS.length - 1 : i] ?? '-';
  return codeToModes(code);
}

/** Every (persona, event) default, flattened (the parity test compares this to the DB). */
export function recipeDefaults(): Array<{ persona: RecipePersona; event: InternalEvent } & RecipeModes> {
  return INTERNAL_EVENTS.flatMap((event) => RECIPE_PERSONAS.map((persona) => ({ persona, event, ...recipeFor(persona, event) })));
}

/** Which modes a channel allows (push and text are instant or off; email may be a digest). */
export function modesFor(channel: NotifyChannel): readonly ChannelMode[] {
  return channel === 'email' ? ['instant', 'digest', 'off'] : ['instant', 'off'];
}

export interface PrefRule {
  event_type: InternalEvent;
  channel: NotifyChannel;
  mode: ChannelMode;
}

/**
 * The effective mode for one cell of the preferences matrix — the same order of precedence as
 * core.notify_modes (mandatory → muted → person's rule → role default), so the screen shows what
 * the engine will do.
 */
export function effectiveMode(args: {
  event: InternalEvent;
  channel: NotifyChannel;
  persona: RecipePersona;
  rules: ReadonlyArray<PrefRule>;
  mandatory: boolean;
  muted?: ReadonlyArray<string>;
  emailOn?: boolean;
  digest?: 'instant' | 'daily' | 'weekly' | 'off';
}): ChannelMode {
  const base = recipeFor(args.persona, args.event)[args.channel];
  if (args.mandatory) return args.channel === 'in_app' ? 'instant' : base;
  if (args.muted?.includes(args.event)) return 'off';
  const rule = args.rules.find((r) => r.event_type === args.event && r.channel === args.channel)?.mode;
  let mode: ChannelMode = rule ?? base;
  if (args.channel !== 'email' && mode === 'digest') mode = args.channel === 'in_app' ? 'instant' : 'off';
  if (args.channel === 'email') {
    if (args.emailOn === false) return 'off';
    if (args.digest === 'off' && mode === 'digest') return 'off';
  }
  return mode;
}
