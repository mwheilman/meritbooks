/**
 * Request & chase engine (migration 178, FPB-request-engine-notifications) — shared types.
 *
 * Every follow-up the product makes (receipt chase, vendor W-9 / COI chase, client
 * questions, document asks, approval nudges, dunning) is ONE `core.requests` row with
 * its own cadence, quiet hours and escalation, plus an append-only `core.request_events`
 * timeline. Literals here mirror the migration's CHECK constraints exactly
 * (schema-contract guard).
 */

export const REQUEST_KINDS = ['receipt', 'w9', 'coi', 'client_question', 'document', 'approval_nudge', 'dunning'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ['open', 'sent', 'snoozed', 'fulfilled', 'cancelled', 'expired'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** Statuses the dispatcher still works on (the "live" set — matches the dedupe index). */
export const LIVE_STATUSES: readonly RequestStatus[] = ['open', 'sent', 'snoozed'];

export const SUBJECT_TYPES = [
  'none', 'vendor', 'vendor_compliance_doc', 'bank_transaction', 'card_transaction', 'bill',
  'invoice', 'customer', 'expense_line', 'approval', 'period', 'job',
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const RECIPIENT_TYPES = ['member', 'vendor_contact', 'customer_contact', 'employee', 'email'] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

export const CHANNELS = ['email', 'sms', 'push', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

export const EVENT_TYPES = [
  'created', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'fulfilled', 'bounced', 'complained',
  'unsubscribed', 'failed', 'skipped', 'escalated', 'snoozed', 'cancelled', 'reopened', 'expired', 'deferred', 'updated',
] as const;
export type RequestEventType = (typeof EVENT_TYPES)[number];

export type FulfilledVia = 'app' | 'resolver' | 'magic_link' | 'manual';
export type RequestSource = 'manual' | 'rule' | 'detector' | 'scheduler';

export const POLICY_KEYS = ['default', 'w9', 'coi', 'coi_renewal', 'client_question', 'document', 'approval_nudge', 'dunning'] as const;
export type PolicyKey = (typeof POLICY_KEYS)[number];

export type CadenceAnchor = 'created' | 'due';

/** The cadence a request carries (copied from the policy at creation; editable per request). */
export interface Cadence {
  anchor: CadenceAnchor;
  /** Minutes from the anchor for the first sends (negative = before the due date). */
  offsetsMinutes: number[];
  /** After the last offset, ask again every N minutes (null = stop after the offsets). */
  repeatEveryMinutes: number | null;
  maxSends: number;
}

/** "HH:MM" pair in the recipient's local time; start > end wraps midnight. */
export interface QuietHours {
  start: string;
  end: string;
}

/** A row of core.requests as the engine reads it. */
export interface RequestRow {
  id: string;
  org_id: string;
  location_id: string | null;
  kind: RequestKind;
  subject_type: SubjectType;
  subject_id: string | null;
  dedupe_key: string | null;
  title: string;
  message: string | null;
  deep_link: string | null;
  recipient_type: RecipientType;
  recipient_membership_id: string | null;
  recipient_vendor_id: string | null;
  recipient_customer_id: string | null;
  recipient_employee_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  recipient_timezone: string | null;
  channels: Channel[];
  cadence_anchor: CadenceAnchor;
  cadence_offsets_minutes: number[];
  repeat_every_minutes: number | null;
  max_sends: number;
  cadence_slot: number;
  quiet_start: string | null;
  quiet_end: string | null;
  escalate_after: number | null;
  escalate_to_membership_id: string | null;
  owner_membership_id: string | null;
  escalated_at: string | null;
  status: RequestStatus;
  due_date: string | null;
  next_send_at: string | null;
  snoozed_until: string | null;
  sends_count: number;
  last_sent_at: string | null;
  bounced_at: string | null;
  unsubscribed_at: string | null;
  fulfilled_at: string | null;
  fulfilled_via: FulfilledVia | null;
  fulfilled_note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  source: RequestSource;
  meta: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestEventRow {
  id: string;
  request_id: string;
  event_type: RequestEventType;
  step: number | null;
  channel: Channel | null;
  delivery_status: 'claimed' | 'sent' | 'failed' | 'skipped' | null;
  provider: string | null;
  provider_message_id: string | null;
  detail: string | null;
  actor: string | null;
  occurred_at: string;
}

/** Plain-English labels (UI + email). */
export const KIND_LABEL: Record<RequestKind, string> = {
  receipt: 'Receipt',
  w9: 'W-9',
  coi: 'Certificate of insurance',
  client_question: 'Question',
  document: 'Document',
  approval_nudge: 'Approval',
  dunning: 'Payment reminder',
};

export function isRequestKind(v: unknown): v is RequestKind {
  return typeof v === 'string' && (REQUEST_KINDS as readonly string[]).includes(v);
}
export function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
}

/** The actor recorded for engine-made changes. */
export const SYSTEM_ACTOR = 'system:requests';
