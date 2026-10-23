/**
 * Response shapes of /api/requests* as the Requests screen reads them, plus the pure
 * presentation helpers (status word + pip, relative times). No React here.
 */
import type { PipKind } from '@meritbooks/merit-ui';
import type { Channel, RequestKind, RequestStatus } from '@/lib/requests/types';

export interface RequestListRow {
  id: string;
  location_id: string | null;
  kind: RequestKind;
  subject_type: string;
  subject_id: string | null;
  title: string;
  recipient_type: string;
  recipient_name: string | null;
  recipient_email: string | null;
  channels: Channel[];
  status: RequestStatus;
  due_date: string | null;
  next_send_at: string | null;
  snoozed_until: string | null;
  sends_count: number;
  last_sent_at: string | null;
  escalated_at: string | null;
  bounced_at: string | null;
  unsubscribed_at: string | null;
  fulfilled_at: string | null;
  fulfilled_via: string | null;
  cancelled_at: string | null;
  max_sends: number;
  quiet_start: string | null;
  quiet_end: string | null;
  source: string;
  created_at: string;
  cadence_text: string;
  has_portal_link: boolean;
}

export interface EmailStatus {
  configured: boolean;
  code: string;
  reason: string | null;
}

export interface RequestListResponse {
  rows: RequestListRow[];
  total: number;
  strip: { open: number; dueSoon: number; escalated: number; undeliverable: number; byKind: Partial<Record<RequestKind, number>> };
  email: EmailStatus;
}

export interface RequestEvent {
  id: string;
  event_type: string;
  step: number | null;
  channel: Channel | null;
  delivery_status: string | null;
  provider: string | null;
  provider_message_id: string | null;
  detail: string | null;
  actor: string | null;
  occurred_at: string;
}

export interface RequestDetailResponse {
  request: RequestListRow & {
    message: string | null;
    deep_link: string | null;
    escalate_after: number | null;
    fulfilled_note: string | null;
    cancel_reason: string | null;
    doc_types: string[];
  };
  clientName: string | null;
  cadenceText: string;
  quiet: { start: string; end: string } | null;
  events: RequestEvent[];
}

export interface PolicyView {
  key: string;
  label: string;
  anchor: 'created' | 'due';
  offsetsMinutes: number[];
  repeatEveryMinutes: number | null;
  maxSends: number;
  escalateAfter: number | null;
  channels: Channel[];
  autoCreate: boolean;
  source: 'default' | 'tenant' | 'receipt_settings';
  cadenceText: string;
  supportsAutoCreate: boolean;
  quiet: { start: string; end: string } | null;
}

export interface PoliciesResponse {
  canEdit: boolean;
  email: EmailStatus;
  tenant: { quiet: { start: string; end: string }; timezone: string; orgTimezone: string | null };
  policies: PolicyView[];
}

export interface RecipientsResponse {
  vendors: Array<{ id: string; name: string; email: string | null }>;
  members: Array<{ membershipId: string; name: string; email: string | null; role: string }>;
}

export interface ActionResponse {
  outcome: string;
  message: string;
  nextSendAt?: string | null;
}

// ── presentation ────────────────────────────────────────────────────────────

export interface StatusLook {
  word: string;
  pip: PipKind;
  attn: boolean;
}

/** Status is never colour alone (kit §7.4): a pip shape plus the word. */
export function statusLook(r: Pick<RequestListRow, 'status' | 'escalated_at' | 'bounced_at' | 'unsubscribed_at' | 'sends_count'>): StatusLook {
  if (r.status === 'fulfilled') return { word: 'Answered', pip: 'ready', attn: false };
  if (r.status === 'cancelled') return { word: 'Cancelled', pip: 'closed', attn: false };
  if (r.status === 'expired') return { word: 'No answer', pip: 'blocked', attn: false };
  if (r.bounced_at) return { word: 'Bounced', pip: 'blocked', attn: true };
  if (r.unsubscribed_at) return { word: 'Unsubscribed', pip: 'blocked', attn: true };
  if (r.status === 'snoozed') return { word: 'Snoozed', pip: 'soft', attn: false };
  if (r.escalated_at) return { word: 'Escalated', pip: 'overdue', attn: true };
  if (r.sends_count === 0) return { word: 'Queued', pip: 'open', attn: false };
  return { word: 'Waiting', pip: 'track', attn: false };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "in 3 days" · "in 2 h" · "now" · "2 days ago". */
export function relative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const d = t - now.getTime();
  const a = Math.abs(d);
  const unit = a >= DAY ? `${Math.round(a / DAY)} day${Math.round(a / DAY) === 1 ? '' : 's'}` : a >= HOUR ? `${Math.round(a / HOUR)} h` : a >= MIN ? `${Math.round(a / MIN)} min` : '';
  if (!unit) return 'now';
  return d > 0 ? `in ${unit}` : `${unit} ago`;
}

/** Whole days since `iso` (age of an ask). */
export function ageDays(iso: string, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));
}

/** "Oct 23, 2:15 PM" in the viewer's zone. */
export function stamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const EVENT_WORD: Record<string, string> = {
  created: 'Created',
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Opened the link',
  replied: 'Replied',
  fulfilled: 'Answered',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  unsubscribed: 'Unsubscribed',
  failed: 'Send failed',
  skipped: 'Not sent',
  escalated: 'Escalated',
  snoozed: 'Snoozed',
  cancelled: 'Cancelled',
  reopened: 'Reopened',
  expired: 'Stopped — no answer',
  deferred: 'Held for quiet hours',
  updated: 'Updated',
};

export function eventWord(e: Pick<RequestEvent, 'event_type' | 'delivery_status' | 'channel' | 'step'>): string {
  const base = e.event_type === 'sent' && e.delivery_status === 'claimed' ? 'Sending' : EVENT_WORD[e.event_type] ?? e.event_type;
  const ch = e.channel ? ` · ${e.channel === 'in_app' ? 'in-app' : e.channel === 'sms' ? 'text' : e.channel}` : '';
  const step = e.event_type === 'sent' && e.step ? ` · ask ${e.step}` : '';
  return `${base}${ch}${step}`;
}

export const KIND_TABS: ReadonlyArray<{ value: 'all' | RequestKind | 'vendor_docs'; label: string; kinds: RequestKind[] | null }> = [
  { value: 'all', label: 'All', kinds: null },
  { value: 'vendor_docs', label: 'W-9 / COI', kinds: ['w9', 'coi'] },
  { value: 'receipt', label: 'Receipts', kinds: ['receipt'] },
  { value: 'client_question', label: 'Questions', kinds: ['client_question'] },
  { value: 'document', label: 'Documents', kinds: ['document'] },
  { value: 'approval_nudge', label: 'Approvals', kinds: ['approval_nudge'] },
  { value: 'dunning', label: 'Payment reminders', kinds: ['dunning'] },
];
