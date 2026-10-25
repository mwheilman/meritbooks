/**
 * Shapes shared by the bell, the inbox, the notification API and the worker. Pure and client-safe.
 * Rows come from core.notifications (Books 178 + 1114) — the one suite inbox.
 */
import type { ChannelMode, InternalEvent, NotifyChannel, RecipePersona } from './recipes';

export type Severity = 'info' | 'attention' | 'critical';

/** One inbox row as the API returns it (already masked per recipient by the database). */
export interface InboxItem {
  id: string;
  kind: string;
  eventType: string | null;
  sourceApp: 'books' | 'projects' | 'suite';
  severity: Severity;
  title: string;
  body: string | null;
  deepLink: string | null;
  jobId: string | null;
  jobLabel: string | null;
  subjectType: string | null;
  subjectId: string | null;
  itemCount: number;
  delivery: 'instant' | 'digest';
  readAt: string | null;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BellPayload {
  unread: number;
  /** Unread rows that need action (attention / critical). */
  needsYou: number;
  items: InboxItem[];
}

export type InboxFilter = 'unread' | 'all' | 'done';

export interface InboxPage {
  items: InboxItem[];
  /** createdAt of the last row, for the next page; null at the end. */
  nextBefore: string | null;
  unread: number;
}

export type MarkState = 'read' | 'unread' | 'done' | 'undone' | 'read_all' | 'done_all';

export interface PrefRuleRow {
  event_type: InternalEvent;
  channel: NotifyChannel;
  mode: ChannelMode;
}

export interface NotificationPrefs {
  persona: RecipePersona;
  digest: 'instant' | 'daily' | 'weekly' | 'off';
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string | null;
  smsPhone: string | null;
  smsConsent: 'opted_in' | 'opted_out' | null;
  /** Books prefs.channels — governs email. */
  emailOn: boolean;
  muted: string[];
  rules: PrefRuleRow[];
  /** Events the company made mandatory (plus the platform-mandatory ones in EVENT_INFO). */
  mandatoryEvents: string[];
  /** Whether this person has a phone registered for push. */
  pushDevices: number;
  /** Texts are set up for at least one of the person's companies. */
  smsAvailable: boolean;
}

export interface CompanyNotifySettings {
  companyId: string;
  customerMessagesLive: boolean;
  liveAt: string | null;
  liveBy: string | null;
  smsEnabled: boolean;
  smsFromNumber: string | null;
  mandatoryEvents: string[];
  pushPerHour: number;
  smsPerDay: number;
  emailPerHour: number;
  customerSmsPerDay: number;
  leadSlaMinutes: number;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string | null;
}

export interface HeldMessage {
  id: string;
  companyId: string | null;
  channel: 'email' | 'sms';
  eventType: string | null;
  toAddress: string;
  subject: string | null;
  /** Null when the reader lacks projects.contract_value at the company (bodyMasked). */
  body: string | null;
  bodyMasked: boolean;
  statusReason: string | null;
  jobId: string | null;
  createdAt: string;
}

/** What the server-side provider adapters report — never "sent" without a provider id. */
export type SendOutcome =
  | { status: 'sent'; provider: string; providerMessageId: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'failed'; reason: string; provider: string; retry: boolean };
